---
name: imagegen
description: Generate or edit raster images through the local Web Image Bridge and the user's logged-in ChatGPT web session. Use for photos, illustrations, sprites, compositing and bitmap assets; use existing vector or code assets for deterministic vector edits.
---

# Images through Web Image Bridge

Use the `web_image_*` tools from the `web_image_bridge` MCP server. The app owns browser submission, observation, downloads and recovery; Codex owns the prompt and visual review.
Do not switch to built-in image generation, an image API, another browser or a second tunnel when this route is unavailable. Report the observed connection or page problem.
These instructions guide tool selection; they cannot intercept built-in tools or override higher-priority instructions.

## Prepare the request

Classify a change that preserves an existing image as `edit`; use `generate` for a new image, optionally with references.
Inspect local inputs with the available image viewer. Keep their order and assign each an explicit role. An edit requires exactly one `edit_target`.
Use this project's [prompting principles](references/prompting.md) and [sample prompts](references/sample-prompts.md) when preparing the request. Read the actual web tool schema for supported parameters.
Preserve exact user text, identity, composition and any requested invariants. Add only details that support the request. Once the final prompt is established, submit it verbatim without silent expansion or translation.
Proceed within the user's existing authorization; ask only for missing material input or a genuinely new request scope.

## Submit and observe

1. Discover the tools and inspect their current schemas. Check `web_image_status` for connection, login, queue and capabilities. `unverified` is not evidence of compatibility: an authorized validation may test it, but do not promise success or retry generation to promote it.
2. Record a fresh UUID `request_id`, the exact request and input manifest in private task state before submitting. Avoid general logs and version control for prompts and user images.
3. Call `web_image_submit` once. Preserve the returned `job_id`, `session_id` and revision. If acceptance is uncertain, query `web_image_get` by the original `request_id`; never invent a replacement key to retry.
4. Use `web_image_wait` with the latest revision and a finite timeout up to 30 seconds. A wait timeout or client disconnect does not cancel the job. Refresh with `web_image_get` when resync is required.
5. For `waiting_user` or `unknown`, preserve the job and explain the observed cause. Show the app's existing Session for login or human verification. Use `reconcile` only to compare existing evidence; it never authorizes a second submission. Control and Session mutations require current revisions and fresh control request IDs.

The app serializes work per profile. Respect manual ownership and unresolved remote execution; do not clear the profile or bypass the queue.
The tool schema is authoritative for fields and defaults. Typical input forms are described in [the tool workflow](references/web-workflow.md).

## Review and deliver

Fetch `web_image_artifacts` after success or partial completion. Use only real downloaded Artifact files; previews and screenshots are not originals.
Inspect the returned image with the local viewer and check the subject, text, layout, identity and requested changes. Report actual dimensions, count and alpha validation when relevant; do not promise a model or resolution that the page did not establish.
For project assets, use `web_image_export` to a registered project folder. Preserve the export ID and receipt across retries. Do not regenerate because a copy failed or overwrite existing assets implicitly.
Render the final local image with an absolute path and provide the usable exported file. Preview-only results may stay in the app's Artifact storage.
For an authorized follow-up edit, preserve `session_id` and `parent_job_id`, supply the parent's Artifact as `edit_target`, use a new request ID and restate invariants. Keep each change targeted.

Retain the request ID, Job ID, Session ID, latest revision, ordered input manifest, export ID, result paths and next action so another turn can resume without duplicate generation.
