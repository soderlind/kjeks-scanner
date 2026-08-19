import { test } from 'node:test';
import assert from 'node:assert/strict';
import { priorTrackerPaths, mergePaths } from '../src/targeting.js';

test( 'extracts the sorted union of observation source_urls', () => {
	const prior = {
		sites: [
			{
				observations: [
					{ name: '_ga', source_urls: [ '/', '/about/' ] },
					{ name: 'sid', source_urls: [ '/about/', '/contact/' ] },
					{ name: 'x', source_urls: [] },
				],
			},
		],
	};
	assert.deepEqual( priorTrackerPaths( prior ), [ '/', '/about/', '/contact/' ] );
} );

test( 'priorTrackerPaths tolerates null / malformed input', () => {
	assert.deepEqual( priorTrackerPaths( null ), [] );
	assert.deepEqual( priorTrackerPaths( {} ), [] );
	assert.deepEqual( priorTrackerPaths( { sites: [ {} ] } ), [] );
} );

test( 'mergePaths de-dupes while preserving order (config first)', () => {
	assert.deepEqual( mergePaths( [ '/', '/x/' ], [ '/x/', '/y/' ] ), [ '/', '/x/', '/y/' ] );
} );

test( 'mergePaths falls back to root', () => {
	assert.deepEqual( mergePaths( [], [] ), [ '/' ] );
} );
