# Example request structures

These are illustrative prompts, not requests to submit automatically. Replace placeholders with the user's requirements and establish the final prompt before calling the bridge.

## New illustration

“Create a square illustration of a ceramic teapot on a kitchen shelf. Use a restrained ink-and-watercolor style, warm daylight, and an uncluttered background. Leave space above the shelf for a heading; do not add text.”

## Two references

“Use Image 1 for the main subject and its appearance. Use Image 2 for the room and camera angle. Place the subject naturally in that room, matching the lighting and perspective. Preserve the subject's identifying details.”

The input array still follows the user's order. Reference numbering must agree with that array.

## Targeted follow-up edit

“In the previous result, change the curtain color to muted green. Preserve the subject, viewpoint, furniture, shadows, and all other colors.”

Use `edit`, the existing `session_id` and `parent_job_id`, and the parent's downloaded artifact as `edit_target`.
The example does not authorize a new request unless the user has asked for this change.
