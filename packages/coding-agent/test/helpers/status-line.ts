interface DisposableStatusLine {
	dispose(): void;
}

/** Owns status-line components created by one test file so teardown cannot leak asynchronous work. */
export class StatusLineTestComponents {
	#components: DisposableStatusLine[] = [];

	/** Tracks a component until this file's teardown. */
	track<T extends DisposableStatusLine>(component: T): T {
		this.#components.push(component);
		return component;
	}

	/** Disposes every tracked component before the file resets global settings. */
	dispose(): void {
		for (const component of this.#components.splice(0)) component.dispose();
	}
}
