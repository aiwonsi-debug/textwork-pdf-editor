# Safe editing contract

Textwork changes original PDF text objects only when the edit is verified safe. A click selects text detected in the page render, but selection alone does not guarantee that the underlying PDF object can be edited. The save process examines the source PDF again and creates a new output only when every queued edit passes its native checks.

| Verification gate | Result when it passes | Result when it fails |
| --- | --- | --- |
| Original text is found exactly once | The selected text object can be considered for editing. | The app reports `text_not_found` or `ambiguous_match`; no output PDF is created. |
| Embedded `/ToUnicode` map is available | The editor can map the selected Unicode characters back to their original PDF glyph codes. | The app reports an unsupported native text object. |
| Original font contains every replacement glyph | The original embedded font resource is retained. | The app reports `missing_glyph`; no visual substitute is added. |
| Replacement has the same Unicode character count | The editor replaces glyph codes without unverified reflow. | The app reports `unsafe_reflow`; no output is generated. |
| Text matrix is axis-aligned | Optional X/Y position adjustment can be applied in PDF points. | The app reports `unsupported_position_adjustment`; the edit remains unapplied. |
| Text object is inside a nested Form XObject | The editor recursively checks the nested form and updates the original text stream. | The app reports the relevant safe failure if its resources cannot be verified. |

The first release deliberately rejects unsafe cases rather than covering text with a new object. This is the central fidelity decision: original PDFs are never overwritten, and a separate output is provided only after every queued edit succeeds.

## Verified example

The supplied agricultural survey PDF was used to verify the server engine. On printed page 3, row `ON-FG-08`, the embedded Thai text `ผัวผัน` was safely replaced with `บัวผัน`. The text was stored in a nested Form XObject and retained the existing embedded `AdobeThai-Regular` font resource.
