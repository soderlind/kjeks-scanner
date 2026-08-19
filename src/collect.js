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
		await page.goto( target, { waitUntil: 'networkidle', timeout: 30000 } ).catch( () => {} );

		// Snapshot after each path; the delta attributes new items to this path.
		lastCookies = await context.cookies();
		lastStorage = await page.evaluate( readStorage );

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
