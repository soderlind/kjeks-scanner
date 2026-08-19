#!/usr/bin/env node
/**
 * Posts scan results to the Kjeks REST import endpoint.
 *
 * Reads one or more scan JSON files and imports each site's observations as
 * UNREVIEWED. Authentication uses a WordPress application password via HTTP
 * Basic auth — supply it through the environment, never on the command line or
 * in the repo.
 *
 * Usage:
 *   KJEKS_USER=admin KJEKS_APP_PASSWORD='xxxx xxxx xxxx' \
 *     node src/import.js --site https://network.example.com scan/*.json
 */

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

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
 * @param {string} [opts.auth]  Authorization header value (default: env basic auth).
 * @param {(message: string, level?: string) => void} [opts.log]
 * @returns {Promise<{ imported: number, failures: number }>}
 */
export async function importSites( base, sites, opts = {} ) {
	const auth = opts.auth || basicAuthFromEnv();
	const log = opts.log || ( () => {} );
	const endpoint = new URL( '/wp-json/kjeks/v1/import', base ).toString();

	let imported = 0;
	let failures = 0;
	for ( const site of sites || [] ) {
		const response = await fetch( endpoint, {
			method: 'POST',
			headers: { 'content-type': 'application/json', authorization: auth },
			body: JSON.stringify( { blog_id: site.blog_id, observations: site.observations } ),
		} );
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
