export type ChatMessage = { id: string; role: "user" | "assistant"; text: string; at: number; source?: string };
export type DashboardBridge = { snapshot(): { messages: ChatMessage[]; usage: string; project: string }; sendMessage(text: string): Promise<void> };

// Export only visible chat text, never tools, hidden reasoning or system context.
export function branchChatMessages(entries: readonly unknown[]): ChatMessage[] {
 const result: ChatMessage[] = [];
 for (const value of entries) {
  const entry = value as { id?: string; timestamp?: string; type?: string; message?: { role?: string; content?: unknown } };
  const message = entry.message;
  if (entry.type !== "message" || !message || (message.role !== "user" && message.role !== "assistant")) continue;
  const content = message.content;
  const text = typeof content === "string" ? content : Array.isArray(content) ? content.filter(part => part?.type === "text" && typeof part.text === "string").map(part => part.text).join("\n") : "";
  if (text.trim()) result.push({ id: `pi-${entry.id}`, role: message.role, text: text.slice(0, 20000), at: Date.parse(entry.timestamp ?? "") || 0, source: "Pi" });
 }
 return result.slice(-100);
}
