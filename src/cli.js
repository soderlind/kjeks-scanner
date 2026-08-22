#!/usr/bin/env node
/**
 * Kjeks discovery scanner CLI.
 *
 * Usage:
 *   node src/cli.js --config config.json --out scan
 *   node src/cli.js --url https://example.com --blog-id 1 --out scan
 *   node src/cli.js --config-url https://net.example/wp-json/kjeks/v1/scan-config --out scan
 *   node src/cli.js --config-url <url> --overlay overlay.json --out scan
 *   node src/cli.js --config config.json --endpoint wss://…browser-run…  (Browser Run)
 *
 * --config-url fetches the site list from WordPress (auth: KJEKS_SCAN_KEY, or
 * KJEKS_USER + KJEKS_APP_PASSWORD env). --overlay merges repo-side paths/scenarios by blog_id.
 *
 * Options:
 *   --concurrency <n>  Sites scanned in parallel (default 3).
 *   --per-host <n>     Parallel scans sharing a hostname (default 2).
 *   --full             Scan the server selection as-is; skip re-scanning pages
 *                      that previously produced a tracker.
 *   --import [<url>]   After scanning, POST observations to the Kjeks import
 *                      endpoint (base from the value, --site, or --config-url).
 *
 * Writes one deterministic JSON file per site to <out>/<host>[_<path>].json and prints a
 * per-subsite diff against any previous file of the same name. Exits non-zero when a
 * subsite changed, a site errored, or an import failed.
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { runScan } from './scan.js';
import { diffScans } from './diff.js';
import { priorTrackerPaths, mergePaths } from './targeting.js';
import { importSites, scanAuthHeaders } from './import.js';

async function main() {
	const args = parseArgs( process.argv.slice( 2 ) );
	const outDir = args.out || 'scan';

	await mkdir( outDir, { recursive: true } );

	// Targeted re-scan: always revisit pages that previously produced a tracker,
	// on top of the server-selected paths. --full scans the selection as-is.
	const config = await applyTargeting( await loadConfig( args ), outDir, Boolean( args.full ) );

	const result = await runScan( config, {
		endpoint: args.endpoint,
		concurrency: args.concurrency ? Number( args.concurrency ) : undefined,
		perHost: args[ 'per-host' ] ? Number( args[ 'per-host' ] ) : undefined,
	} );
	let anyChanged = false;

	for ( const site of result.sites ) {
		const slug = siteFileSlug( site );
		const file = join( outDir, `${ slug }.json` );
		const previous = existsSync( file ) ? JSON.parse( await readFile( file, 'utf8' ) ) : null;

		const [ siteDiff ] = diffScans( previous, { sites: [ site ] } );

		const single = { generated_at: result.generated_at, sites: [ site ] };
		await writeFile( file, stableStringify( single ) + '\n', 'utf8' );

		printDiff( slug, siteDiff );

		if ( siteDiff && ( siteDiff.added.length || siteDiff.changed.length || siteDiff.removed.length ) ) {
			anyChanged = true;
		}
	}

	// Surface isolated per-site scan failures (the run continued past them).
	const scanErrors = result.errors || [];
	for ( const failure of scanErrors ) {
		process.stderr.write( `scan error (blog ${ failure.site && failure.site.blog_id }): ${ failure.message }\n` );
	}

	// Optional: import the reviewed-less observations in the same run.
	let importFailures = 0;
	if ( args.import ) {
		const base = ( typeof args.import === 'string' ? args.import : null )
			|| args.site
			|| originOf( args[ 'config-url' ] );
		if ( ! base ) {
			throw new Error( '--import needs a base URL: use --import <url>, --site <url>, or --config-url.' );
		}
		const outcome = await importSites( base, result.sites, {
			log: ( message, level ) => ( level === 'error' ? process.stderr : process.stdout ).write( message + '\n' ),
		} );
		importFailures = outcome.failures;
	}

	// Non-zero exit if any subsite changed, any site errored, or an import failed.
	process.exitCode = ( anyChanged || scanErrors.length > 0 || importFailures > 0 ) ? 1 : 0;
}

function originOf( url ) {
	if ( ! url || typeof url !== 'string' ) {
		return null;
	}
	try {
		return new URL( url ).origin;
	} catch ( e ) {
		return null;
	}
}

// Distinct output name per site. Subdirectory multisites share one host, so the
// path is folded in; subdomain/domain-mapped sites keep their host-only name.
function siteFileSlug( site ) {
	let path = '';
	try {
		path = new URL( site.url ).pathname;
	} catch ( e ) {
		path = '';
	}
	const trimmed = path.replace( /^\/+|\/+$/g, '' );
	const suffix = trimmed ? '_' + trimmed.replace( /[^a-z0-9._-]+/gi, '-' ) : '';
	return `${ site.host }${ suffix }`;
}

function printDiff( host, diff ) {
	if ( ! diff ) {
		return;
	}
	const total = diff.added.length + diff.changed.length + diff.removed.length;
	if ( total === 0 ) {
		process.stdout.write( `${ host }: no changes\n` );
		return;
	}
	process.stdout.write(
		`${ host }: ${ diff.added.length } new, ${ diff.changed.length } changed, ${ diff.removed.length } removed\n`
	);
	for ( const o of diff.added ) {
		process.stdout.write( `  + ${ o.storage_type } ${ o.name }${ o.domain ? ' @ ' + o.domain : '' }\n` );
	}
	for ( const o of diff.removed ) {
		process.stdout.write( `  - ${ o.storage_type } ${ o.name }${ o.domain ? ' @ ' + o.domain : '' }\n` );
	}
}

/**
 * Adds paths that previously produced a tracker (read from each site's prior
 * committed scan file) to the config paths, so known-tracker pages are always
 * re-checked. Skipped when `full` is set.
 */
async function applyTargeting( config, outDir, full ) {
	if ( full ) {
		return config;
	}

	const sites = [];
	for ( const site of config.sites || [] ) {
		const file = join( outDir, `${ siteFileSlug( site ) }.json` );
		let prior = null;
		if ( existsSync( file ) ) {
			try {
				prior = JSON.parse( await readFile( file, 'utf8' ) );
			} catch ( e ) {
				prior = null;
			}
		}
		sites.push( { ...site, paths: mergePaths( site.paths, priorTrackerPaths( prior ) ) } );
	}

	return { ...config, sites };
}

async function loadConfig( args ) {
	if ( args.config ) {
		return JSON.parse( await readFile( args.config, 'utf8' ) );
	}
	if ( args[ 'config-url' ] ) {
		return applyOverlay( await fetchConfig( args[ 'config-url' ] ), args.overlay );
	}
	if ( args.url ) {
		return {
			sites: [
				{
					url: args.url,
					blog_id: args[ 'blog-id' ] ? Number( args[ 'blog-id' ] ) : 1,
					paths: args.path ? [].concat( args.path ) : [ '/' ],
				},
			],
		};
	}
	throw new Error( 'Provide --config <file>, --config-url <url>, or --url <url>.' );
}

/**
 * Fetches the scanner config from the WordPress REST endpoint.
 *
 * Prefers a shared scanner key (KJEKS_SCAN_KEY) sent in the X-Kjeks-Key header,
 * falling back to an application password via HTTP Basic auth — both supplied
 * through the environment.
 */
async function fetchConfig( url ) {
	const headers = scanAuthHeaders();
	if ( ! headers ) {
		throw new Error( '--config-url requires KJEKS_SCAN_KEY (or KJEKS_USER and KJEKS_APP_PASSWORD) in the environment.' );
	}
	const response = await fetch( url, { headers } );
	if ( ! response.ok ) {
		const body = await response.text().catch( () => '' );
		throw new Error( `config-url returned ${ response.status }${ body ? `: ${ body.slice( 0, 300 ) }` : '' }` );
	}
	const contentType = response.headers.get( 'content-type' ) || '';
	if ( ! contentType.includes( 'json' ) ) {
		throw new Error(
			`config-url did not return JSON (content-type: ${ contentType || 'unknown' }, final URL: ${ response.url }). ` +
				'The endpoint is likely behind a login or access-restriction gate — set KJEKS_SCAN_KEY and ensure the site trusts it.'
		);
	}
	return response.json();
}

/**
 * Merges a repo-side overlay (paths / scenarios keyed by blog_id) into the
 * site list fetched from REST. Operator intent stays in the repo; the live
 * site list stays authoritative.
 */
async function applyOverlay( config, overlayPath ) {
	if ( ! overlayPath ) {
		return config;
	}
	const overlay = JSON.parse( await readFile( overlayPath, 'utf8' ) );
	const byBlog = new Map( ( overlay.sites || [] ).map( ( s ) => [ s.blog_id, s ] ) );

	config.sites = ( config.sites || [] ).map( ( site ) => {
		const extra = byBlog.get( site.blog_id );
		if ( ! extra ) {
			return site;
		}
		return {
			...site,
			paths: extra.paths && extra.paths.length ? extra.paths : site.paths,
			scenarios: extra.scenarios || site.scenarios,
		};
	} );

	return config;
}

function parseArgs( argv ) {
	const args = {};
	for ( let i = 0; i < argv.length; i++ ) {
		const token = argv[ i ];
		if ( token.startsWith( '--' ) ) {
			const key = token.slice( 2 );
			const next = argv[ i + 1 ];
			if ( ! next || next.startsWith( '--' ) ) {
				args[ key ] = true;
			} else {
				args[ key ] = args[ key ] ? [].concat( args[ key ], next ) : next;
				i++;
			}
		}
	}
	return args;
}

/**
 * Stable JSON: object keys sorted recursively so output is byte-stable.
 */
function stableStringify( value ) {
	return JSON.stringify( sortKeys( value ), null, '\t' );
}

function sortKeys( value ) {
	if ( Array.isArray( value ) ) {
		return value.map( sortKeys );
	}
	if ( value && typeof value === 'object' ) {
		return Object.keys( value )
			.sort()
			.reduce( ( acc, key ) => {
				acc[ key ] = sortKeys( value[ key ] );
				return acc;
			}, {} );
	}
	return value;
}

main().catch( ( error ) => {
	process.stderr.write( `kjeks-scan: ${ error.message }\n` );
	process.exitCode = 2;
} );
