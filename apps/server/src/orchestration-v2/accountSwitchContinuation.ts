/**
 * A continuation on another account because the last one ran out. Agents otherwise read a limit
 * stop as a reason to stop delegating or wait for the reset. The prompt comes first so a skill
 * invocation in it stays the message's first word.
 */
export const accountSwitchContinuation = (prompt: string) =>
  `${prompt}\n\nYour previous account hit its usage limit, so this chat moved to another account with room. Subagents and new chats are also routed to accounts with room, so keep working and delegating as usual.`;
