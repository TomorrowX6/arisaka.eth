import type { AUTO_MODE, DARK_MODE, LIGHT_MODE } from "@constants/constants";

export type SiteConfig = {
	title: string;
	subtitle: string;

	lang:
		| "en"
		| "zh_CN"
		| "zh_TW"
		| "ja"
		| "ko"
		| "es"
		| "th"
		| "vi"
		| "tr"
		| "id";

	themeColor: {
		hue: number;
		fixed: boolean;
	};
	banner: {
		enable: boolean;
		src: string;
		position?: "top" | "center" | "bottom";
		credit: {
			enable: boolean;
			text: string;
			url?: string;
		};
	};
	toc: {
		enable: boolean;
		depth: 1 | 2 | 3;
	};

	favicon: Favicon[];
};

export type Favicon = {
	src: string;
	theme?: "light" | "dark";
	sizes?: string;
};

export enum LinkPreset {
	Home = 0,
	Archive = 1,
	About = 2,
	Friends = 3,
}

export type FriendLink = {
	name: string;
	url: string;
	/** Avatar image URL. Falls back to the first letter of the name. */
	avatar?: string;
	description?: string;
	/** Omit for an active link. Listed separately when set. */
	status?: "unreachable" | "banned";
};

export type FriendsConfig = {
	links: FriendLink[];
};

export type NavBarLink = {
	name: string;
	url: string;
	external?: boolean;
};

export type NavBarConfig = {
	links: (NavBarLink | LinkPreset)[];
};

export type ProfileConfig = {
	avatar?: string;
	name: string;
	bio?: string;
	links: {
		name: string;
		url: string;
		icon: string;
	}[];
};

export type LicenseConfig = {
	enable: boolean;
	name: string;
	url: string;
};

export type MidiTrack = {
	title: string;
	/** Path to a .mid file, relative to the /public directory */
	url: string;
};

export type MidiPlayerConfig = {
	enable: boolean;
	/**
	 * GM sound bank used to synthesize the MIDI files (SF2 / SF3 / DLS).
	 * Relative to the /public directory. Only fetched once playback starts.
	 */
	soundBank: string;
	/**
	 * Track list, regenerated from the contents of public/midi by
	 * `scripts/scan-midi-playlist.mjs` on every dev/build run.
	 */
	playlist: string;
};

export type CommentConfig = {
	enable: boolean;
	/** Waline server address, e.g. https://waline.example.com */
	serverURL: string;
};

export type LIGHT_DARK_MODE =
	| typeof LIGHT_MODE
	| typeof DARK_MODE
	| typeof AUTO_MODE;

export type BlogPostData = {
	body: string;
	title: string;
	published: Date;
	description: string;
	tags: string[];
	draft?: boolean;
	image?: string;
	category?: string;
};

export type ExpressiveCodeConfig = {
	theme: string;
};
