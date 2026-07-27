/**
 * Scans public/midi for MIDI files and writes the player's playlist.json.
 *
 * The playlist is kept out of the page HTML on purpose: the sidebar renders on
 * every page, so baking the track list in would rewrite every single HTML file
 * whenever a song is added — an expensive diff to push to the permaweb. This
 * way only playlist.json and the new .mid change.
 *
 * Track titles come straight from the file names, so renaming a file renames
 * the track.
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

const tracks = fs
	.readdirSync(midiDir, { withFileTypes: true })
	.filter(
		(entry) =>
			entry.isFile() &&
			MIDI_EXTENSIONS.has(path.extname(entry.name).toLowerCase()),
	)
	.map((entry) => entry.name)
	.sort(collator.compare)
	.map((name) => ({
		title: path.basename(name, path.extname(name)),
		url: `/midi/${encodeURIComponent(name)}`,
	}));

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
