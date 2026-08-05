import { defineCollection, z } from "astro:content";

const postsCollection = defineCollection({
	schema: z
		.object({
			title: z.string(),
			published: z.date(),
			updated: z.date().optional(),
			draft: z.boolean().optional().default(false),
			description: z.string().optional().default(""),
			image: z.string().optional().default(""),
			tags: z.array(z.string()).optional().default([]),
			category: z.string().optional().nullable().default(""),
			lang: z.string().optional().default(""),
			encrypted: z.boolean().optional().default(false),
			password: z.string().optional().default(""),
			passwordEnv: z.string().optional().default(""),
			passwordHint: z.string().optional().default(""),
		})
		.superRefine((post, context) => {
			if (!post.encrypted) return;

			const configuredPasswords =
				Number(post.password.length > 0) + Number(post.passwordEnv.length > 0);
			if (configuredPasswords !== 1) {
				context.addIssue({
					code: z.ZodIssueCode.custom,
					message:
						"Encrypted posts must set exactly one of password or passwordEnv",
					path: ["password"],
				});
			}
			if (
				post.passwordEnv.length > 0 &&
				(!/^[A-Z_][A-Z0-9_]*$/.test(post.passwordEnv) ||
					post.passwordEnv.startsWith("PUBLIC_"))
			) {
				context.addIssue({
					code: z.ZodIssueCode.custom,
					message:
						"passwordEnv must name a private, uppercase environment variable",
					path: ["passwordEnv"],
				});
			}
		}),
});
const specCollection = defineCollection({
	schema: z.object({}),
});
export const collections = {
	posts: postsCollection,
	spec: specCollection,
};
