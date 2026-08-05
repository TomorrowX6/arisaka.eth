import { type CollectionEntry, getCollection } from "astro:content";

// // Retrieve posts and sort them by publication date
export async function getSortedPosts() {
	const allBlogPosts = await getCollection("posts", ({ data }) => {
		return import.meta.env.PROD ? data.draft !== true : true;
	});

	const sorted = allBlogPosts.sort((a, b) => {
		const dateA = new Date(a.data.published);
		const dateB = new Date(b.data.published);
		return dateA > dateB ? -1 : 1;
	});
	return sorted;
}
export type PublicPostData = Pick<
	CollectionEntry<"posts">["data"],
	| "title"
	| "published"
	| "updated"
	| "draft"
	| "description"
	| "image"
	| "tags"
	| "category"
	| "lang"
	| "encrypted"
>;
export type PostForList = {
	slug: string;
	data: PublicPostData;
};
export async function getSortedPostsList(): Promise<PostForList[]> {
	const sortedFullPosts = await getSortedPosts();
	return sortedFullPosts.map((post) => ({
		slug: post.slug,
		data: {
			title: post.data.title,
			published: post.data.published,
			updated: post.data.updated,
			draft: post.data.draft,
			description: post.data.description,
			image: post.data.image,
			tags: post.data.tags,
			category: post.data.category,
			lang: post.data.lang,
			encrypted: post.data.encrypted,
		},
	}));
}
