<script lang="ts">
// the AudioWorklet processor has to be served as its own file
import processorUrl from "spessasynth_lib/dist/spessasynth_processor.min.js?url";
import { onDestroy, onMount } from "svelte";
import { midiPlayerConfig } from "../../config";
import type { MidiTrack } from "../../types/config";

let tracks: MidiTrack[] = [];

let status: "idle" | "loading" | "ready" | "error" = "idle";
let message = "";
let index = 0;
let loadedIndex = -1;
let playing = false;
let seeking = false;
let showPlaylist = false;
let currentTime = 0;
let duration = 0;
let volume = 0.7;

let ctx: AudioContext | undefined;
let gain: GainNode | undefined;
// biome-ignore lint/suspicious/noExplicitAny: the sequencer type only exists in the lazily imported module
let seq: any;
let ticker: ReturnType<typeof setInterval> | undefined;

onMount(async () => {
	try {
		const response = await fetch(midiPlayerConfig.playlist);
		if (!response.ok) throw new Error(`playlist: HTTP ${response.status}`);
		tracks = await response.json();
	} catch (error) {
		status = "error";
		message = error instanceof Error ? error.message : String(error);
	}
});

function formatTime(seconds: number): string {
	if (!Number.isFinite(seconds) || seconds < 0) return "0:00";
	const total = Math.floor(seconds);
	return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

function startTicker() {
	stopTicker();
	ticker = setInterval(() => {
		if (seq && !seeking) currentTime = seq.currentTime;
	}, 250);
}

function stopTicker() {
	if (ticker) clearInterval(ticker);
	ticker = undefined;
}

/**
 * Boots the synthesizer. Everything it needs — the library, the worklet and
 * the sound bank — is only fetched here, so a visitor who never presses play
 * never downloads any of it.
 */
async function buildEngine() {
	const { WorkletSynthesizer, Sequencer } = await import("spessasynth_lib");

	const audio = new AudioContext();
	await audio.audioWorklet.addModule(processorUrl);

	const response = await fetch(midiPlayerConfig.soundBank);
	if (!response.ok) throw new Error(`sound bank: HTTP ${response.status}`);
	const bank = await response.arrayBuffer();

	const synth = new WorkletSynthesizer(audio);
	await synth.soundBankManager.addSoundBank(bank, "main");
	await synth.isReady;

	const output = audio.createGain();
	output.gain.value = volume;
	synth.connect(output);
	output.connect(audio.destination);

	const sequencer = new Sequencer(synth, { skipToFirstNoteOn: true });
	sequencer.loopCount = 0;
	sequencer.eventHandler.addEvent("songChange", "sidebar-player", () => {
		duration = sequencer.duration;
		currentTime = 0;
	});
	sequencer.eventHandler.addEvent("songEnded", "sidebar-player", () => {
		void skip(1);
	});

	ctx = audio;
	gain = output;
	seq = sequencer;
}

async function loadTrack(target: number) {
	const response = await fetch(tracks[target].url);
	if (!response.ok)
		throw new Error(`${tracks[target].url}: HTTP ${response.status}`);
	seq.loadNewSongList([
		{ binary: await response.arrayBuffer(), fileName: tracks[target].title },
	]);
	loadedIndex = target;
}

async function start() {
	if (tracks.length === 0) return;
	try {
		if (!seq) {
			status = "loading";
			await buildEngine();
		}
		if (ctx?.state === "suspended") await ctx.resume();
		if (loadedIndex !== index) {
			status = "loading";
			await loadTrack(index);
		}
		status = "ready";
		// a sequence that ran to its end has to be rewound before it plays again
		if (seq.isFinished) seq.currentTime = 0;
		seq.play();
		playing = true;
		startTicker();
	} catch (error) {
		status = "error";
		message = error instanceof Error ? error.message : String(error);
		playing = false;
		stopTicker();
	}
}

function pause() {
	seq?.pause();
	playing = false;
	stopTicker();
}

function toggle() {
	if (playing) pause();
	else void start();
}

async function skip(delta: number) {
	if (tracks.length === 0) return;
	index = (index + delta + tracks.length) % tracks.length;
	currentTime = 0;
	if (seq) await start();
}

async function select(target: number) {
	if (target === index && playing) return;
	index = target;
	currentTime = 0;
	await start();
}

function handleSeek() {
	if (seq && duration > 0) seq.currentTime = currentTime;
}

$: if (gain) gain.gain.value = volume;
$: empty = tracks.length === 0;
$: title = status === "error" ? message : (tracks[index]?.title ?? "No tracks");

onDestroy(() => {
	stopTicker();
	void ctx?.close();
});
</script>

<div class="pb-1">
    <!-- current track -->
    <div class="flex items-center gap-2 h-7">
        <svg class="w-4 h-4 shrink-0 {status === 'error' ? 'text-[var(--meta-divider)]' : 'text-[var(--primary)]'}" viewBox="0 0 24 24" aria-hidden="true">
            <path fill="currentColor" d="M10 21q-1.65 0-2.825-1.175T6 17t1.175-2.825T10 13q.575 0 1.063.138t.937.412V4q0-.425.288-.712T13 3h4q.425 0 .713.288T18 4v2q0 .425-.288.713T17 7h-3v10q0 1.65-1.175 2.825T10 21"/>
        </svg>
        <div class="text-sm truncate {status === 'error' || empty ? 'text-30' : 'text-90 font-bold'}" title={title}>{title}</div>
    </div>

    <!-- progress -->
    <input
        class="player-range w-full"
        type="range"
        min="0"
        max={duration || 1}
        step="0.1"
        aria-label="Seek"
        bind:value={currentTime}
        on:pointerdown={() => (seeking = true)}
        on:pointerup={() => (seeking = false)}
        on:input={handleSeek}
        disabled={!seq || duration <= 0}
    />
    <div class="flex justify-between text-xs text-30 tabular-nums -mt-1">
        <span>{formatTime(currentTime)}</span>
        <span>{formatTime(duration)}</span>
    </div>

    <!-- transport -->
    <div class="flex items-center gap-1 mt-1">
        <button class="btn-plain w-8 h-8 rounded-lg shrink-0 disabled:opacity-40" aria-label="Previous track" disabled={empty} on:click={() => skip(-1)}>
            <svg class="w-5 h-5" viewBox="0 0 24 24" aria-hidden="true">
                <path fill="currentColor" d="M5.5 17V7q0-.425.288-.712T6.5 6t.713.288T7.5 7v10q0 .425-.288.713T6.5 18t-.712-.288T5.5 17m11.45-.025l-6.2-4.15q-.225-.15-.337-.362T10.3 12t.113-.462t.337-.363l6.2-4.15q.125-.1.275-.125t.275-.025q.4 0 .7.275t.3.725v8.25q0 .45-.3.725t-.7.275q-.125 0-.275-.025t-.275-.125"/>
            </svg>
        </button>

        <button class="btn-plain w-8 h-8 rounded-lg shrink-0 disabled:opacity-40" aria-label={playing ? "Pause" : "Play"} disabled={empty} on:click={toggle}>
            {#if status === "loading"}
                <svg class="w-5 h-5 animate-spin" viewBox="0 0 24 24" aria-hidden="true">
                    <circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-dasharray="40 20"/>
                </svg>
            {:else if playing}
                <svg class="w-5 h-5" viewBox="0 0 24 24" aria-hidden="true">
                    <path fill="currentColor" d="M16 19q-.825 0-1.412-.587T14 17V7q0-.825.588-1.412T16 5t1.413.588T18 7v10q0 .825-.587 1.413T16 19m-8 0q-.825 0-1.412-.587T6 17V7q0-.825.588-1.412T8 5t1.413.588T10 7v10q0 .825-.587 1.413T8 19"/>
                </svg>
            {:else}
                <svg class="w-5 h-5" viewBox="0 0 24 24" aria-hidden="true">
                    <path fill="currentColor" d="M8 17.175V6.825q0-.425.3-.713t.7-.287q.125 0 .263.037t.262.113l8.15 5.175q.225.15.338.375t.112.475t-.112.475t-.338.375l-8.15 5.175q-.125.075-.262.113T9 18.175q-.4 0-.7-.288t-.3-.712"/>
                </svg>
            {/if}
        </button>

        <button class="btn-plain w-8 h-8 rounded-lg shrink-0 disabled:opacity-40" aria-label="Next track" disabled={empty} on:click={() => skip(1)}>
            <svg class="w-5 h-5" viewBox="0 0 24 24" aria-hidden="true">
                <path fill="currentColor" d="M16.5 17V7q0-.425.288-.712T17.5 6t.713.288T18.5 7v10q0 .425-.288.713T17.5 18t-.712-.288T16.5 17m-11-.875v-8.25q0-.45.3-.725t.7-.275q.125 0 .275.025t.275.125l6.2 4.15q.225.15.338.363T13.7 12t-.112.463t-.338.362l-6.2 4.15q-.125.1-.275.125t-.275.025q-.4 0-.7-.275t-.3-.725"/>
            </svg>
        </button>

        <svg class="w-4 h-4 ml-1 shrink-0 text-30" viewBox="0 0 24 24" aria-hidden="true">
            <path fill="currentColor" d="M19 11.975q0-2.075-1.1-3.787t-2.95-2.563q-.375-.175-.55-.537t-.05-.738q.15-.4.538-.575t.787 0Q18.1 4.85 19.55 7.063T21 11.974t-1.45 4.913t-3.875 3.287q-.4.175-.788 0t-.537-.575q-.125-.375.05-.737t.55-.538q1.85-.85 2.95-2.562t1.1-3.788M7 15H4q-.425 0-.712-.288T3 14v-4q0-.425.288-.712T4 9h3l3.3-3.3q.475-.475 1.088-.213t.612.938v11.15q0 .675-.612.938T10.3 18.3zm9.5-3q0 1.05-.475 1.988t-1.25 1.537q-.25.15-.513.013T14 15.1V8.85q0-.3.263-.437t.512.012q.775.625 1.25 1.575t.475 2"/>
        </svg>
        <input class="player-range grow min-w-0" type="range" min="0" max="1" step="0.01" aria-label="Volume" bind:value={volume} />

        {#if tracks.length > 1}
            <button
                class="btn-plain w-8 h-8 rounded-lg shrink-0 {showPlaylist ? 'text-[var(--primary)] bg-[var(--btn-plain-bg-hover)]' : ''}"
                aria-label="Playlist"
                aria-expanded={showPlaylist}
                aria-controls="midi-playlist"
                title={`${tracks.length} tracks`}
                on:click={() => (showPlaylist = !showPlaylist)}
            >
                <svg class="w-5 h-5" viewBox="0 0 24 24" aria-hidden="true">
                    <path fill="currentColor" d="M16 20q-1.25 0-2.125-.875T13 17t.875-2.125T16 14q.275 0 .525.038T17 14.2V7q0-.425.288-.712T18 6h3q.425 0 .713.288T22 7t-.288.713T21 8h-2v9q0 1.25-.875 2.125T16 20M4 16q-.425 0-.712-.288T3 15t.288-.712T4 14h6q.425 0 .713.288T11 15t-.288.713T10 16zm0-4q-.425 0-.712-.288T3 11t.288-.712T4 10h10q.425 0 .713.288T15 11t-.288.713T14 12zm0-4q-.425 0-.712-.288T3 7t.288-.712T4 6h10q.425 0 .713.288T15 7t-.288.713T14 8z"/>
                </svg>
            </button>
        {/if}
    </div>

    <!-- playlist -->
    {#if tracks.length > 1 && showPlaylist}
        <div id="midi-playlist" class="mt-2 pt-2 flex flex-col border-t-[1px] border-dashed border-[var(--line-divider)]">
            {#each tracks as track, i}
                <button
                    class="btn-plain rounded-lg h-8 px-2 !justify-start text-xs truncate {i === index ? 'text-[var(--primary)] font-bold' : 'text-75'}"
                    on:click={() => select(i)}
                >
                    {track.title}
                </button>
            {/each}
        </div>
    {/if}
</div>

<style>
    .player-range {
        -webkit-appearance: none;
        appearance: none;
        height: 1.25rem;
        background: transparent;
        cursor: pointer;
    }
    .player-range:disabled {
        cursor: default;
        opacity: 0.5;
    }
    .player-range::-webkit-slider-runnable-track {
        height: 4px;
        border-radius: 9999px;
        background: var(--btn-regular-bg);
    }
    .player-range::-webkit-slider-thumb {
        -webkit-appearance: none;
        appearance: none;
        width: 10px;
        height: 10px;
        margin-top: -3px;
        border-radius: 9999px;
        background: var(--primary);
    }
    .player-range::-moz-range-track {
        height: 4px;
        border-radius: 9999px;
        background: var(--btn-regular-bg);
    }
    .player-range::-moz-range-thumb {
        width: 10px;
        height: 10px;
        border: none;
        border-radius: 9999px;
        background: var(--primary);
    }
</style>
