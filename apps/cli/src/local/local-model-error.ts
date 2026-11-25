/** A local model failure, in the words the chat shows. */
export class LocalModelError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LocalModelError";
  }
}
