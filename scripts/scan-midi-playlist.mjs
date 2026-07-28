/**
 * Scans public/midi for MIDI files and writes the player's playlist.json.
 *
 * The playlist is kept out of the page HTML on purpose: the sidebar renders on
 * every page, so baking the track list in would rewrite every single HTML file
 * whenever a song is added — an expensive diff to push to the permaweb. This
 * way only playlist.json and the new .mid change.
 *
 * Track titles come straight from the file names, so renaming a file renames
 * the track — with one substitution: an underscore in the file name is shown
 * as a space. Files must stay space-free because arweave.net's gateway cannot
 * resolve a manifest path containing a literal space; the upload succeeds and
 * then every request for it 404s. Dropping in "Chaos King.mid" is still fine,
 * this script renames it to "Chaos_King.mid" on the next scan.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const MIDI_EXTENSIONS = new Set([".mid", ".midi", ".rmi"]);

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const midiDir = path.join(root, "public", "midi");
const playlistFile = path.join(midiDir, "playlist.json");

if (!fs.existsSync(midiDir)) {
	fs.mkdirSync(midiDir, { recursive: true });
}

const collator = new Intl.Collator(undefined, {
	numeric: true,
	sensitivity: "base",
});

const found = fs
	.readdirSync(midiDir, { withFileTypes: true })
	.filter(
		(entry) =>
			entry.isFile() &&
			MIDI_EXTENSIONS.has(path.extname(entry.name).toLowerCase()),
	)
	.map((entry) => entry.name);

/** Puts a file on a path the gateway can serve, without touching its title. */
function makeServable(name) {
	const servable = name.replaceAll(" ", "_");
	if (servable === name) return name;
	if (fs.existsSync(path.join(midiDir, servable))) {
		console.warn(`  ! kept "${name}" — "${servable}" already exists`);
		return name;
	}
	fs.renameSync(path.join(midiDir, name), path.join(midiDir, servable));
	console.log(`  renamed "${name}" -> "${servable}"`);
	return servable;
}

const tracks = found
	.map(makeServable)
	.map((name) => ({
		title: path.basename(name, path.extname(name)).replaceAll("_", " "),
		url: `/midi/${encodeURIComponent(name)}`,
	}))
	// Sorted by the displayed title so the underscores never affect the order.
	.sort((a, b) => collator.compare(a.title, b.title));

const serialized = `${JSON.stringify(tracks, null, "\t")}\n`;
const previous = fs.existsSync(playlistFile)
	? fs.readFileSync(playlistFile, "utf8")
	: null;

if (previous === serialized) {
	console.log(`midi playlist unchanged (${tracks.length} tracks)`);
} else {
	fs.writeFileSync(playlistFile, serialized);
	console.log(
		`midi playlist written: ${tracks.length} track(s)${tracks.length ? ` — ${tracks.map((t) => t.title).join(", ")}` : ""}`,
	);
}
