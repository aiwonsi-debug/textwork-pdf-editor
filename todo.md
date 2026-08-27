# Project TODO

- [x] Create a safe server-side PDF inspection workflow that identifies selectable text, page dimensions, text bounds, font resources, and nested Form XObject candidates.
- [x] Implement a server-side native text-edit engine that changes PDF text only after an unambiguous match, supported text matrix, available embedded glyphs, and safe layout conditions are verified.
- [x] Return structured edit status for applied, unsupported, ambiguous, missing-glyph, text-not-found, and unsafe-reflow outcomes.
- [x] Generate a separate edited PDF and keep the uploaded original unchanged.
- [x] Build a page-by-page browser workspace with PDF upload, page navigation, rendered page preview, and detected-text selection.
- [x] Provide an edit inspector with original text, replacement text, position adjustment controls, confidence status, and clear safe-edit guidance.
- [x] Provide a download flow for the newly generated PDF and a transparent per-edit results report.
- [x] Apply an elegant, polished visual design with responsive layout, keyboard-accessible controls, visible focus states, and clear loading/error states.
- [x] Add Vitest coverage for safe-edit validation, structured error reporting, and generated-output handling.
- [x] Verify the browser UI with desktop and mobile screenshots, run type checks and tests, and document supported and unsupported PDF cases.
- [x] Expose font-resource and nested Form XObject inspection metadata for every PDF page.
- [x] Show a visible per-edit verification report for every queued edit in the browser workspace.
- [x] Add test coverage for all-safe versus blocked output handling and structured edit result reporting.
- [x] Export the completed Textwork source to a private GitHub repository and verify the pushed commit.
