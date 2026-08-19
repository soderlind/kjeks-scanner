import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mapWithLimit } from '../src/scan.js';

const tick = () => new Promise( ( r ) => setTimeout( r, 5 ) );

test( 'preserves input order in results', async () => {
	const items = [ { id: 0 }, { id: 1 }, { id: 2 }, { id: 3 } ];
	const out = await mapWithLimit(
		items,
		{ concurrency: 2, perHost: 2, hostOf: () => 'h' },
		async ( item ) => {
			await tick();
			return item.id * 10;
		}
	);
	assert.deepEqual( out, [ 0, 10, 20, 30 ] );
} );

test( 'never exceeds the global concurrency cap', async () => {
	let active = 0;
	let peak = 0;
	const items = Array.from( { length: 8 }, ( _, i ) => ( { host: 'h' + i } ) );
	await mapWithLimit(
		items,
		{ concurrency: 3, perHost: 3, hostOf: ( i ) => i.host },
		async () => {
			active++;
			peak = Math.max( peak, active );
			await tick();
			active--;
		}
	);
	assert.ok( peak <= 3, `peak ${ peak } exceeded 3` );
} );

test( 'never exceeds the per-host cap', async () => {
	const hostActive = new Map();
	let peakSameHost = 0;
	// 6 items all sharing one host.
	const items = Array.from( { length: 6 }, () => ( { host: 'shared' } ) );
	await mapWithLimit(
		items,
		{ concurrency: 5, perHost: 2, hostOf: ( i ) => i.host },
		async ( i ) => {
			const n = ( hostActive.get( i.host ) || 0 ) + 1;
			hostActive.set( i.host, n );
			peakSameHost = Math.max( peakSameHost, n );
			await tick();
			hostActive.set( i.host, hostActive.get( i.host ) - 1 );
		}
	);
	assert.equal( peakSameHost, 2 );
} );

test( 'isolates a failing item without aborting the run', async () => {
	const items = [ { id: 0 }, { id: 1 }, { id: 2 } ];
	const out = await mapWithLimit(
		items,
		{ concurrency: 2, perHost: 2, hostOf: () => 'h' },
		async ( item ) => {
			if ( item.id === 1 ) {
				throw new Error( 'boom' );
			}
			return item.id;
		}
	);
	assert.equal( out[ 0 ], 0 );
	assert.equal( out[ 2 ], 2 );
	assert.ok( out[ 1 ] && out[ 1 ].__error instanceof Error );
	assert.equal( out[ 1 ].__error.message, 'boom' );
} );
