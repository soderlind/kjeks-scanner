#!/usr/bin/env node
/**
 * Posts scan results to the Kjeks REST import endpoint.
 *
 * Reads one or more scan JSON files and imports each site's observations as
 * UNREVIEWED. Authentication prefers a shared scanner key (KJEKS_SCAN_KEY) sent
 * in the X-Kjeks-Key header — which survives proxies that strip the
 * Authorization header — and falls back to a WordPress application password via
 * HTTP Basic auth. Supply credentials through the environment, never on the
 * command line or in the repo.
 *
 * Usage:
 *   KJEKS_SCAN_KEY='<key>' \
 *     node src/import.js --site https://network.example.com scan/*.json
 *   KJEKS_USER=admin KJEKS_APP_PASSWORD='xxxx xxxx xxxx' \
 *     node src/import.js --site https://network.example.com scan/*.json
 */

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

/**
 * Builds auth headers for the Kjeks REST endpoints.
 *
 * Prefers a shared scanner key (KJEKS_SCAN_KEY) sent in the X-Kjeks-Key header,
 * which survives proxies that strip Authorization. Falls back to a WordPress
 * application password via HTTP Basic auth. Returns null when neither is set.
 *
 * @returns {Record<string, string>|null}
 */
export function scanAuthHeaders() {
	const key = process.env.KJEKS_SCAN_KEY;
	if ( key ) {
		return { 'x-kjeks-key': key };
	}
	const user = process.env.KJEKS_USER;
	const password = process.env.KJEKS_APP_PASSWORD;
	if ( user && password ) {
		return { authorization: 'Basic ' + Buffer.from( `${ user }:${ password }` ).toString( 'base64' ) };
	}
	return null;
}

export function basicAuthFromEnv() {
	const user = process.env.KJEKS_USER;
	const password = process.env.KJEKS_APP_PASSWORD;
	if ( ! user || ! password ) {
		throw new Error( 'Set KJEKS_USER and KJEKS_APP_PASSWORD in the environment.' );
	}
	return 'Basic ' + Buffer.from( `${ user }:${ password }` ).toString( 'base64' );
}

/**
 * POSTs each site's observations to the Kjeks import endpoint as UNREVIEWED.
 *
 * @param {string} base   Network base URL.
 * @param {object[]} sites  Sites with { blog_id, observations }.
 * @param {object} [opts]
 * @param {Record<string, string>} [opts.headers]  Auth headers (default: env key/basic auth).
 * @param {string} [opts.auth]  Legacy Authorization header value.
 * @param {(message: string, level?: string) => void} [opts.log]
 * @returns {Promise<{ imported: number, failures: number }>}
 */
export async function importSites( base, sites, opts = {} ) {
	const authHeaders = opts.headers
		|| ( opts.auth ? { authorization: opts.auth } : scanAuthHeaders() );
	if ( ! authHeaders ) {
		throw new Error( 'Set KJEKS_SCAN_KEY (or KJEKS_USER and KJEKS_APP_PASSWORD) in the environment.' );
	}
	const log = opts.log || ( () => {} );
	const endpoint = new URL( '/wp-json/kjeks/v1/import', base ).toString();

	let imported = 0;
	let failures = 0;
	for ( const site of sites || [] ) {
		let response;
		try {
			response = await fetch( endpoint, {
				method: 'POST',
				headers: { 'content-type': 'application/json', ...authHeaders },
				body: JSON.stringify( { blog_id: site.blog_id, observations: site.observations } ),
				signal: AbortSignal.timeout( 30000 ),
			} );
		} catch ( error ) {
			const reason = error && error.name === 'TimeoutError'
				? 'request timed out after 30s'
				: String( ( error && error.message ) || error );
			log( `Import failed for blog ${ site.blog_id }: ${ reason }`, 'error' );
			failures++;
			continue;
		}
		const body = await response.json().catch( () => ( {} ) );
		if ( ! response.ok ) {
			log( `Import failed for blog ${ site.blog_id }: ${ response.status } ${ JSON.stringify( body ) }`, 'error' );
			failures++;
			continue;
		}
		imported += Number( body.imported ) || 0;
		log( `blog ${ site.blog_id }: imported ${ body.imported } unreviewed observation(s)` );
	}

	return { imported, failures };
}

async function main() {
	const args = process.argv.slice( 2 );
	const siteIndex = args.indexOf( '--site' );
	if ( siteIndex === -1 ) {
		throw new Error( 'Provide --site <network-base-url>.' );
	}
	const base = args[ siteIndex + 1 ];
	const files = args.filter( ( a, i ) => i !== siteIndex && i !== siteIndex + 1 && ! a.startsWith( '--' ) );

	let failures = 0;
	for ( const file of files ) {
		const scan = JSON.parse( await readFile( file, 'utf8' ) );
		const result = await importSites( base, scan.sites, {
			log: ( message, level ) => ( level === 'error' ? process.stderr : process.stdout ).write( message + '\n' ),
		} );
		failures += result.failures;
	}
	if ( failures ) {
		process.exitCode = 1;
	}
}

// Only run as a CLI when executed directly (not when imported by scan CLI).
if ( process.argv[ 1 ] && fileURLToPath( import.meta.url ) === process.argv[ 1 ] ) {
	main().catch( ( error ) => {
		process.stderr.write( `kjeks-import: ${ error.message }\n` );
		process.exitCode = 2;
	} );
}
