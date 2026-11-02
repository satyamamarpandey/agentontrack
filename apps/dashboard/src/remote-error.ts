/** Kept apart from the phone backend so the phone screens can name it without pulling any Firebase code into a build that has no accounts. */
export class RemoteError extends Error { constructor(readonly code: string, message: string) { super(message); } }
