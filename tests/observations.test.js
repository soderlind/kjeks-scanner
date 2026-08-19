import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deriveObservations } from '../src/scan.js';

test( 'attaches source_urls from per-state sources', () => {
	const states = [
		{
			state: 'accept-all',
			cookies: [
				{ name: '_ga', domain: '.ex.com', path: '/', party: 'third', secure: true, http_only: false, same_site: 'Lax', session: false },
			],
			localStorage: [],
			sessionStorage: [],
			indexedDB: [],
			thirdPartyHosts: [ 'google-analytics.com' ],
			beacons: [],
			scripts: [],
			iframes: [],
			redirects: [],
		},
	];
	const sourcesByState = [
		{
			state: 'accept-all',
			sources: {
				'cookie|_ga|.ex.com': [ '/', '/about/' ],
				'script|google-analytics.com': [ '/about/' ],
			},
		},
	];

	const obs = deriveObservations( states, sourcesByState );

	const ga = obs.find( ( o ) => o.name === '_ga' );
	assert.deepEqual( ga.source_urls, [ '/', '/about/' ] );
	assert.deepEqual( ga.triggered_by, [ 'accept-all' ] );

	const script = obs.find( ( o ) => o.storage_type === 'script' );
	assert.deepEqual( script.source_urls, [ '/about/' ] );
} );

test( 'merges source_urls across states and de-dupes', () => {
	const cookie = { name: 'sid', domain: '.ex.com', path: '/', party: 'first', secure: false, http_only: true, same_site: 'Lax', session: true };
	const states = [
		{ state: 'only-analytics', cookies: [ cookie ], localStorage: [], sessionStorage: [], indexedDB: [], thirdPartyHosts: [], beacons: [], scripts: [], iframes: [], redirects: [] },
		{ state: 'accept-all', cookies: [ cookie ], localStorage: [], sessionStorage: [], indexedDB: [], thirdPartyHosts: [], beacons: [], scripts: [], iframes: [], redirects: [] },
	];
	const sourcesByState = [
		{ state: 'only-analytics', sources: { 'cookie|sid|.ex.com': [ '/' ] } },
		{ state: 'accept-all', sources: { 'cookie|sid|.ex.com': [ '/', '/contact/' ] } },
	];

	const obs = deriveObservations( states, sourcesByState );
	const sid = obs.find( ( o ) => o.name === 'sid' );

	assert.deepEqual( sid.source_urls, [ '/', '/contact/' ] );
	assert.deepEqual( sid.triggered_by, [ 'accept-all', 'only-analytics' ] );
} );

test( 'works without sources (back-compat)', () => {
	const states = [
		{ state: 'before-choice', cookies: [], localStorage: [ 'foo' ], sessionStorage: [], indexedDB: [], thirdPartyHosts: [], beacons: [], scripts: [], iframes: [], redirects: [] },
	];

	const obs = deriveObservations( states );
	const foo = obs.find( ( o ) => o.name === 'foo' );

	assert.deepEqual( foo.source_urls, [] );
} );
