// The same limits as firestore.rules.
export const MAX_MESSAGE = 2000;
export const MAX_CONTACT = 200;
export type Rating = 'helpful' | 'not-helpful' | null;
export interface Feedback { rating: Rating; message: string; contact: string }

export function cleanFeedback(rating: Rating, message: string, contact: string): Feedback {
  const m = message.trim();
  const c = contact.trim();
  if (!m) throw new Error('Write a message first.');
  if (m.length > MAX_MESSAGE) throw new Error(`Keep the message to ${MAX_MESSAGE} characters.`);
  if (c.length > MAX_CONTACT) throw new Error(`Keep the contact to ${MAX_CONTACT} characters.`);
  return { rating, message: m, contact: c };
}
