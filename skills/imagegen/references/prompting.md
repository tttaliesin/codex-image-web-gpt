# Writing prompts for this bridge

The bridge sends a final text prompt to ChatGPT. It does not expose model selection, image quality, seed, or API-only generation controls.

## Before submission

- Establish the visible outcome: subject, setting, composition, requested text, and intended use.
- Inspect each input and preserve the user's ordering. Assign the contract's roles, including exactly one `edit_target` for an edit.
- Explain each reference's contribution in the prompt when several inputs could otherwise be confused.
- For edits, state the requested change and the visual properties that must remain stable: identity, pose, framing, colors, typography, or layout.
- Include dimensions, transparency, or output count only when the user needs them. Inspect the downloaded result before claiming those requirements were met.
- Once the user-authorized prompt is final, preserve its text exactly. The bridge's request ID protects replay; it is not permission to revise the prompt during a retry.

## Visual review

Compare the downloaded original with the instructions and inputs. Check the subject, text spelling, reference fidelity, composition, cropping, and the specific edit.
Separate visual defects from download or export failures: an existing valid image should be recovered or copied rather than regenerated.
If a further edit is authorized, use the prior session and parent job and describe the smallest necessary change.

These notes are maintained by this project and are independent of any locally installed Codex skill bundle.
