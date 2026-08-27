/**
 * Per-state forensic collection.
 *
 * Attaches network listeners, drives a page, and reads all client-side storage
 * surfaces. HttpOnly cookies are only available via context.cookies() (CDP),
 * never document.cookie — which is exactly why a real, CDP-capable browser is
 * required (see docs/adr/0005).
 */

/**
 * Approximate registrable domain (eTLD+1). Good enough for first/third-party
 * classification; documented as a known limitation.
 *
 * @param {string} host
 */
export function registrableDomain( host ) {
	const labels = String( host || '' ).split( '.' ).filter( Boolean );
	if ( labels.length <= 2 ) {
		return labels.join( '.' );
	}
	return labels.slice( -2 ).join( '.' );
}

function isBeacon( request ) {
	const type = request.resourceType();
	if ( type === 'beacon' || type === 'ping' ) {
		return true;
	}
	const url = request.url();
	return /\.(gif|png)(\?|$)/i.test( url ) && /(pixel|track|beacon|collect|pageview)/i.test( url );
}

// Resource types that hold a connection open indefinitely; excluding them lets
// the settle detector fire instead of waiting for a stream that never ends.
const LONG_LIVED = new Set( [ 'websocket', 'eventsource' ] );

/**
 * Resolves when the page's network has genuinely drained, not after a fixed
 * delay: it tracks in-flight requests and returns once none are pending for
 * `quietMs`. Long-lived connections (websocket/eventsource) are ignored so a
 * persistent stream can't stall the scan. `timeout` is only a safety cap for
 * pathological pages (e.g. XHR long-polling) that never go quiet.
 *
 * @param {import('playwright').Page} page
 * @param {object} [options]
 * @param {number} [options.quietMs]  Idle window that counts as settled (default 500).
 * @param {number} [options.timeout]  Hard cap in ms (default 15000).
 */
function waitForNetworkSettled( page, { quietMs = 500, timeout = 15000 } = {} ) {
	return new Promise( ( resolve ) => {
		let inflight = 0;
		let done = false;
		let quietTimer = null;

		const finish = () => {
			if ( done ) {
				return;
			}
			done = true;
			clearTimeout( quietTimer );
			clearTimeout( hardCap );
			page.off( 'request', onRequest );
			page.off( 'requestfinished', onSettle );
			page.off( 'requestfailed', onSettle );
			resolve();
		};

		const scheduleQuiet = () => {
			clearTimeout( quietTimer );
			if ( inflight === 0 ) {
				quietTimer = setTimeout( finish, quietMs );
			}
		};

		const onRequest = ( request ) => {
			if ( LONG_LIVED.has( request.resourceType() ) ) {
				return;
			}
			inflight++;
			clearTimeout( quietTimer );
		};

		const onSettle = ( request ) => {
			if ( LONG_LIVED.has( request.resourceType() ) ) {
				return;
			}
			inflight = Math.max( 0, inflight - 1 );
			scheduleQuiet();
		};

		const hardCap = setTimeout( finish, timeout );
		page.on( 'request', onRequest );
		page.on( 'requestfinished', onSettle );
		page.on( 'requestfailed', onSettle );

		// The page may already be idle after navigation resolved.
		scheduleQuiet();
	} );
}

/**
 * Races a promise against a timeout, resolving to `fallback` if it doesn't
 * settle in time (or rejects). Lets the scan abandon a page read that hangs
 * because the target blocked its main thread, instead of stalling forever.
 *
 * @template T
 * @param {Promise<T>} promise
 * @param {number} ms
 * @param {T} fallback
 * @returns {Promise<T>}
 */
function withTimeout( promise, ms, fallback ) {
	let timer;
	const guard = new Promise( ( resolve ) => {
		timer = setTimeout( () => resolve( fallback ), ms );
	} );
	const settled = Promise.resolve( promise ).then(
		( value ) => {
			clearTimeout( timer );
			return value;
		},
		() => {
			clearTimeout( timer );
			return fallback;
		}
	);
	return Promise.race( [ settled, guard ] );
}

/**
 * Collects observations for a single already-configured page.
 *
 * @param {import('playwright').Page} page
 * @param {import('playwright').BrowserContext} context
 * @param {object} options
 * @param {string} options.firstPartyDomain  Registrable domain of the site.
 * @param {string[]} options.paths            Paths to visit (relative or absolute).
 * @param {string} options.baseUrl            Site base URL.
 */
export async function collect( page, context, { firstPartyDomain, paths, baseUrl } ) {
	const requests = [];
	const redirects = [];
	const setCookies = [];
	let currentPath = paths && paths.length ? String( paths[ 0 ] ) : '/';

	page.on( 'request', ( request ) => {
		let host = '';
		try {
			host = new URL( request.url() ).hostname;
		} catch ( e ) {
			host = '';
		}
		const party = registrableDomain( host ) === firstPartyDomain ? 'first' : 'third';
		requests.push( {
			url: request.url(),
			host,
			method: request.method(),
			resourceType: request.resourceType(),
			party,
			beacon: isBeacon( request ),
			path: currentPath,
		} );
	} );

	page.on( 'response', ( response ) => {
		const headers = response.headers();
		if ( headers[ 'set-cookie' ] ) {
			setCookies.push( { url: response.url(), setCookie: headers[ 'set-cookie' ] } );
		}
		if ( response.status() >= 300 && response.status() < 400 && headers.location ) {
			redirects.push( { from: response.url(), to: headers.location } );
		}
	} );

	// First path where each cumulative cookie / storage key appears — the basis
	// for per-URL attribution (which page a tracker actually loads on).
	const cookieFirstSeen = new Map();
	const localFirstSeen = new Map();
	const sessionFirstSeen = new Map();
	const idbFirstSeen = new Map();

	let lastCookies = [];
	let lastStorage = { documentCookie: [], localStorage: [], sessionStorage: [], indexedDB: [], scripts: [], iframes: [] };

	// Resolve paths relative to the site base so subdirectory multisites work:
	// new URL( '/', 'https://host/sub/' ) would resolve to the domain root and
	// scan the wrong site. Treat a leading-slash path as relative to the base.
	const base = baseUrl.endsWith( '/' ) ? baseUrl : baseUrl + '/';
	for ( const path of paths ) {
		currentPath = String( path );
		const target = path.startsWith( 'http' )
			? path
			: new URL( String( path ).replace( /^\/+/, '' ), base ).toString();
		await page.goto( target, { waitUntil: 'domcontentloaded', timeout: 30000 } ).catch( () => {} );
		// Continue the instant real loading finishes instead of waiting out a
		// fixed delay; the cap only guards pages that never go quiet.
		await waitForNetworkSettled( page, { quietMs: 500, timeout: 15000 } );

		// Snapshot after each path; the delta attributes new items to this path.
		// Both reads are capped: a page that blocks its main thread can hang
		// evaluate()/cookies() indefinitely, so fall back to the prior snapshot.
		lastCookies = await withTimeout( context.cookies(), 15000, lastCookies );
		lastStorage = await withTimeout( page.evaluate( readStorage ), 15000, lastStorage );

		for ( const c of lastCookies ) {
			const key = `${ c.name }|${ c.domain }`;
			if ( ! cookieFirstSeen.has( key ) ) {
				cookieFirstSeen.set( key, currentPath );
			}
		}
		for ( const k of lastStorage.localStorage ) {
			if ( ! localFirstSeen.has( k ) ) {
				localFirstSeen.set( k, currentPath );
			}
		}
		for ( const k of lastStorage.sessionStorage ) {
			if ( ! sessionFirstSeen.has( k ) ) {
				sessionFirstSeen.set( k, currentPath );
			}
		}
		for ( const k of lastStorage.indexedDB ) {
			if ( ! idbFirstSeen.has( k ) ) {
				idbFirstSeen.set( k, currentPath );
			}
		}
	}

	const cookies = lastCookies;
	const storage = lastStorage;
	const sources = buildSources( { requests, cookieFirstSeen, localFirstSeen, sessionFirstSeen, idbFirstSeen } );

	return {
		cookies: cookies.map( ( c ) => ( {
			name: c.name,
			domain: c.domain,
			path: c.path,
			secure: c.secure,
			http_only: c.httpOnly,
			same_site: c.sameSite,
			session: c.expires === -1,
			party: registrableDomain( ( c.domain || '' ).replace( /^\./, '' ) ) === firstPartyDomain ? 'first' : 'third',
		} ) ),
		documentCookie: storage.documentCookie,
		localStorage: storage.localStorage,
		sessionStorage: storage.sessionStorage,
		indexedDB: storage.indexedDB,
		scripts: storage.scripts,
		iframes: storage.iframes,
		requests,
		redirects,
		setCookies,
		sources,
	};
}

/**
 * Maps observation keys to the sorted list of paths that produced them. Keys
 * match scan.js deriveObservations() so attribution merges cleanly.
 */
function buildSources( { requests, cookieFirstSeen, localFirstSeen, sessionFirstSeen, idbFirstSeen } ) {
	const sources = {};
	const add = ( key, path ) => {
		if ( ! path ) {
			return;
		}
		( sources[ key ] ||= new Set() ).add( path );
	};

	for ( const r of requests ) {
		if ( r.party === 'third' ) {
			add( `script|${ r.host }`, r.path );
		}
		if ( r.beacon ) {
			add( `pixel|${ stripQuery( r.url ) }`, r.path );
		}
	}
	for ( const [ key, path ] of cookieFirstSeen ) {
		add( `cookie|${ key }`, path );
	}
	for ( const [ key, path ] of localFirstSeen ) {
		add( `localstorage|${ key }`, path );
	}
	for ( const [ key, path ] of sessionFirstSeen ) {
		add( `sessionstorage|${ key }`, path );
	}
	for ( const [ key, path ] of idbFirstSeen ) {
		add( `indexeddb|${ key }`, path );
	}

	const out = {};
	for ( const key of Object.keys( sources ) ) {
		out[ key ] = Array.from( sources[ key ] ).sort();
	}
	return out;
}

function stripQuery( url ) {
	try {
		const u = new URL( url );
		return u.origin + u.pathname;
	} catch ( e ) {
		return url;
	}
}

/* Runs in the page context. */
function readStorage() {
	const names = ( store ) => {
		try {
			return Object.keys( store );
		} catch ( e ) {
			return [];
		}
	};
	return Promise.resolve()
		.then( async () => {
			let idb = [];
			try {
				if ( indexedDB.databases ) {
					idb = ( await indexedDB.databases() ).map( ( d ) => d.name ).filter( Boolean );
				}
			} catch ( e ) {
				idb = [];
			}
			return {
				documentCookie: ( document.cookie || '' )
					.split( ';' )
					.map( ( c ) => c.split( '=' )[ 0 ].trim() )
					.filter( Boolean ),
				localStorage: names( window.localStorage ),
				sessionStorage: names( window.sessionStorage ),
				indexedDB: idb,
				scripts: Array.from( document.querySelectorAll( 'script[src]' ) ).map( ( s ) => s.src ),
				iframes: Array.from( document.querySelectorAll( 'iframe[src]' ) ).map( ( f ) => f.src ),
			};
		} );
}
