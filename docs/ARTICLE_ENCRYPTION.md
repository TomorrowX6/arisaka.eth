# Article encryption

Fuwari can encrypt a post body during a static build and decrypt it locally in the reader's browser. Plain posts are unchanged.

> [!IMPORTANT]
> This protects the generated post body, not the Markdown source. Do not commit a confidential plaintext article or its password to a public repository. Build machines, repository history, covers, linked assets, and previous deployments are outside this protection boundary.

## Configure a post

Use a private environment variable for repositories that readers can access:

```yaml
---
title: Private notes
published: 2026-08-05
encrypted: true
passwordEnv: PRIVATE_NOTES_PASSWORD
passwordHint: "A public, optional hint"
---
```

Set the variable before starting or building the site:

```sh
PRIVATE_NOTES_PASSWORD='use-a-long-random-passphrase' pnpm build
```

A missing or empty variable fails the build without printing its value. Variable names beginning with `PUBLIC_` are rejected because Astro exposes public variables to browser code.

For a private source repository, an inline password is also supported:

```yaml
encrypted: true
password: "use-a-long-random-passphrase"
```

Set exactly one of `password` and `passwordEnv` when `encrypted` is `true`.

If GitHub Actions builds an encrypted post, create a repository Actions secret and explicitly map it into each build/deploy job:

```yaml
env:
  PRIVATE_NOTES_PASSWORD: ${{ secrets.PRIVATE_NOTES_PASSWORD }}
```

## Encryption envelope

Every build creates a new versioned envelope:

```text
reader password
  └─ scrypt (N=2^17, r=8, p=1, random 16-byte salt)
       └─ 256-bit KEK
            └─ AES-256-GCM unwrap (random 12-byte IV)
                 └─ random 256-bit per-article DEK
                      └─ AES-256-GCM decrypt (independent random 12-byte IV)
                           └─ rendered article HTML
```

The Web Crypto AES-GCM output stores `ciphertext || 128-bit tag`. The KEK only wraps the random DEK; it never encrypts article content directly. Version, algorithms, KDF parameters, salt, purpose, and the expected post slug are authenticated as domain-separated additional data. This makes swapped envelopes, wrapped keys, slugs, headers, and ciphertext fail authentication.

The browser validates the complete envelope before running scrypt. It derives the KEK with `@noble/hashes`, unwraps the DEK, and decrypts the article with Web Crypto. Passwords are not logged, put in URLs, persisted in browser storage, or included in generated HTML. Decrypted DOM is cleared when Swup navigation or `pagehide` begins.

## Public information and limitations

The following remain public by design:

- title, publication dates, description, tags, category, language, and password hint;
- cover images and every file under `public/` or emitted as a linked post asset;
- article URL, ciphertext size (and therefore an approximate upper bound on body size), comments, and deployment history.

Encrypted bodies and headings are omitted from cards, RSS content, the initial table of contents, and Pagefind input. The table of contents is rebuilt in memory after a successful unlock.

This is password-based client-side confidentiality, not access control:

- Anyone can download the envelope and attempt password guesses offline. Use a high-entropy passphrase; scrypt slows guesses but cannot repair a weak password.
- A script running with the site's origin can observe content after the reader unlocks it. Keep dependencies and the site free of cross-site scripting vulnerabilities.
- Password rotation only affects new builds. Cached, mirrored, or immutable Arweave deployments remain decryptable with their original password.
- Raw scripts embedded in encrypted Markdown are inserted as inert HTML and are not executed after decryption.
