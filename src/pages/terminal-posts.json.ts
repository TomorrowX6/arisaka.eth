import type { APIRoute } from "astro";
import { getSortedPostsList } from "../utils/content-utils";
import { formatDateToYYYYMMDD } from "../utils/date-utils";

export const GET: APIRoute = async () => {
	const posts = (await getSortedPostsList()).map((post) => ({
		slug: post.slug,
		title: post.data.title,
		published: formatDateToYYYYMMDD(post.data.published),
		description: post.data.description ?? "",
		category: post.data.category ?? "",
		tags: post.data.tags ?? [],
	}));

	return new Response(`${JSON.stringify(posts)}\n`, {
		headers: { "Content-Type": "application/json; charset=utf-8" },
	});
};
