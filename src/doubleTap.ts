import type { CmdkTriggerKey } from "./floatSearchTypes";

const MODIFIER_FLAGS: Record<
	Exclude<CmdkTriggerKey, "none">,
	"shiftKey" | "ctrlKey" | "altKey" | "metaKey"
> = {
	Shift: "shiftKey",
	Control: "ctrlKey",
	Alt: "altKey",
	Meta: "metaKey",
};

/**
 * Detects a double tap of a single modifier key (e.g. Shift, Shift).
 *
 * A tap only counts when the key is pressed and released on its own: any other
 * key or mouse button pressed in between (Ctrl+C, Shift+click, ...) cancels the
 * sequence. Listeners must be registered in the capture phase so that keys
 * handled (and stopped) by the editor are still seen.
 */
export class DoubleTapDetector {
	private armed = false;
	private downAt = 0;
	private lastTapAt = 0;

	constructor(
		private readonly getKey: () => CmdkTriggerKey,
		private readonly getInterval: () => number,
		private readonly onDoubleTap: () => void
	) {}

	reset = () => {
		this.armed = false;
		this.lastTapAt = 0;
	};

	onKeyDown = (e: KeyboardEvent) => {
		const key = this.getKey();
		if (key === "none") return;

		if (e.key !== key) {
			// Any other key in between breaks the sequence (Ctrl+C, Ctrl+C ...).
			this.reset();
			return;
		}
		if (e.repeat) {
			// Holding the key down is not a tap.
			this.reset();
			return;
		}

		const otherModifierHeld = (
			Object.keys(MODIFIER_FLAGS) as (keyof typeof MODIFIER_FLAGS)[]
		).some((mod) => mod !== key && e[MODIFIER_FLAGS[mod]]);
		if (otherModifierHeld) {
			this.reset();
			return;
		}

		this.armed = true;
		this.downAt = Date.now();
	};

	onKeyUp = (e: KeyboardEvent) => {
		const key = this.getKey();
		if (key === "none" || e.key !== key) return;
		if (!this.armed) {
			this.lastTapAt = 0;
			return;
		}
		this.armed = false;

		const now = Date.now();
		const interval = this.getInterval();
		if (now - this.downAt > interval) {
			// A long press is not a tap.
			this.lastTapAt = 0;
			return;
		}
		if (this.lastTapAt && now - this.lastTapAt <= interval) {
			this.lastTapAt = 0;
			this.onDoubleTap();
			return;
		}
		this.lastTapAt = now;
	};
}
