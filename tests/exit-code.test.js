import { test } from 'node:test';
import assert from 'node:assert/strict';
import { exitCodeFor } from '../src/exit-code.js';

test( 'clean run exits 0', () => {
	assert.equal( exitCodeFor( { errored: false, changed: false, noFailOnChange: false } ), 0 );
} );

test( 'a changed subsite exits 3 (review needed)', () => {
	assert.equal( exitCodeFor( { errored: false, changed: true, noFailOnChange: false } ), 3 );
} );

test( '--no-fail-on-change downgrades a changed-only run to 0', () => {
	assert.equal( exitCodeFor( { errored: false, changed: true, noFailOnChange: true } ), 0 );
} );

test( 'errors exit 1 and outrank changes', () => {
	assert.equal( exitCodeFor( { errored: true, changed: false, noFailOnChange: false } ), 1 );
	assert.equal( exitCodeFor( { errored: true, changed: true, noFailOnChange: false } ), 1 );
} );

test( '--no-fail-on-change does not mask real errors', () => {
	assert.equal( exitCodeFor( { errored: true, changed: true, noFailOnChange: true } ), 1 );
} );
