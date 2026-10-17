## 2024-05-24 - Implicit Form Controls Need Explicit Aria Labels
**Learning:** When using Obsidian's `createEl` to dynamically generate an `<input>` field without a matching `<label>`, screen readers may lack context if relying solely on a preceding `<p>` or `placeholder`.
**Action:** Always provide an `aria-label` attribute directly to the `<input>` element using the localized prompt string.
