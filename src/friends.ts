import { profileConfig } from "./config";
import type { FriendsConfig } from "./types/config";

export const friendsConfig: FriendsConfig = {
	links: [
		{
			name: "Mashiro Arisaka",
			url: "https://arisaka.eth.limo/",
			avatar: profileConfig.avatar,
			description:
				"Day before yesterday I saw a rabbit, and yesterday a deer, and today, you.",
		},
		{
			name: "Innei",
			url: "https://innei.in/",
			avatar: "https://avatars.githubusercontent.com/u/41265413?v=5",
			description:
				"Innei's personal blog on frontend and full-stack development — TypeScript, React, Next.js, AI engineering, indie hacking, travel and life.",
		},
		// {
		// 	name: "Someone",
		// 	url: "https://example.com/",
		// 	avatar: "https://example.com/avatar.png", // optional
		// 	description: "A short introduction",      // optional
		// 	status: "unreachable",                    // optional: "unreachable" | "banned"
		// },
	],
};
