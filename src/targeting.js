/**
 * Incremental targeting: always re-scan URLs that previously loaded a tracker.
 *
 * Pure helpers (no filesystem) so they unit-test without a browser. The CLI
 * reads the prior committed per-site scan file and feeds its observations here.
 */

/**
 * Union of `source_urls` across every observation in a prior scan file.
 *
 * @param {object|null} priorScan  Parsed previous per-site scan ({ sites: [...] }).
 * @returns {string[]} Sorted, unique paths that previously produced a tracker.
 */
export function priorTrackerPaths( priorScan ) {
	if ( ! priorScan || ! Array.isArray( priorScan.sites ) ) {
		return [];
	}
	const set = new Set();
	for ( const site of priorScan.sites ) {
		for ( const observation of site.observations || [] ) {
			for ( const url of observation.source_urls || [] ) {
				set.add( url );
			}
		}
	}
	return Array.from( set ).sort();
}

/**
 * Config paths plus prior tracker paths, de-duped and order-stable.
 *
 * @param {string[]} configPaths
 * @param {string[]} priorPaths
 * @returns {string[]}
 */
export function mergePaths( configPaths, priorPaths ) {
	const out = [];
	for ( const path of [ ...( configPaths || [] ), ...( priorPaths || [] ) ] ) {
		if ( ! out.includes( path ) ) {
			out.push( path );
		}
	}
	return out.length ? out : [ '/' ];
}
