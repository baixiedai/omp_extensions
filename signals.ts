/** DeerMem-inspired hints only: the model must still verify the evidence. */
const patterns: Record<string, RegExp[]> = {
	correction: [/\bthat(?:'s| is) (?:wrong|incorrect)\b/iu, /\byou misunderstood\b/iu, /\btry again\b/iu, /\bredo\b/iu, /不对|你理解错了|你理解有误|重试|重新来|换一种|改用/u],
	reinforcement: [/\byes[,.]?\s+(?:exactly|perfect|that(?:'s| is) (?:right|correct|it))\b/iu, /\bperfect(?:[.!?]|$)/iu, /\bexactly\s+(?:right|correct)\b/iu, /\bthat(?:'s| is)\s+(?:exactly\s+)?(?:right|correct|what i (?:wanted|needed|meant))\b/iu, /\bkeep\s+(?:doing\s+)?that\b/iu, /\bjust\s+(?:like\s+)?(?:that|this)\b/iu, /\bthis is (?:great|helpful)\b(?:[.!?]|$)/iu, /\bthis is what i wanted\b(?:[.!?]|$)/iu, /对[，,]?\s*就是这样(?:[。！？!?.]|$)|完全正确(?:[。！？!?.]|$)|(?:对[，,]?\s*)?就是这个意思(?:[。！？!?.]|$)|正是我想要的(?:[。！？!?.]|$)|继续保持(?:[。！？!?.]|$)|(?:以后|今后)(?:都|一直)?保持这样(?:[。！？!?.]|$)/u],
	decision: [/\blet.s (?:go with|use|pick|choose)\b/iu, /\bI.ll (?:go with|use|pick|choose)\b/iu, /\bwe (?:should|will) (?:go with|use|pick|choose)\b/iu, /\bI (?:decide|chose|selected) to\b/iu, /就用|决定用|决定采用|我们选|我选|就采用/u],
	goal: [/\bI (?:plan to|want to|am going to|aim to|intend to)\b/iu, /\bmy goal is\b/iu, /\bI.m going to\b/iu, /\bnext I.ll\b/iu, /我的目标是|我打算|我准备|接下来我要|接下来我打算|我想做/u],
	preference: [/\bI (?:prefer|like|love|dislike|hate)\b/iu, /\bmy preference is\b/iu, /我(?:更)?(?:喜欢|偏好|倾向于|不喜欢|讨厌)/u],
	identity: [/\bI am (?:a|an|the)\b/iu, /\bI(?:'m| am) (?:the|our)\b/iu, /\bmy role is\b/iu, /\bI work as\b/iu, /我是(?:一名|一个|本项目的|这个项目的)?/u],
};

const trivialAcknowledgements = [/^(?:ok(?:ay)?|k|thanks?|thank you|got it|understood|noted|sure|sounds good|you're welcome)[.!\s]*$/iu, /^(?:好|好的|行|可以|收到|明白|知道了|了解|谢谢|多谢|嗯+|哦+)[。！？!?.\s]*$/u];
export type SignalKind = keyof typeof patterns | "trivial";
export type SignalPatternOverrides = Partial<Record<SignalKind, string[]>>;

function expressionsFor(name: SignalKind, overrides: SignalPatternOverrides): RegExp[] {
	const custom = overrides[name];
	if (custom === undefined) return name === "trivial" ? trivialAcknowledgements : patterns[name];
	return custom.map(pattern => new RegExp(pattern, "iu"));
}

function userText(text: string): string | undefined {
	return /^(?:user):\s*([\s\S]*)$/u.exec(text)?.[1];
}

export function isTrivialAcknowledgement(text: string, overrides: SignalPatternOverrides = {}): boolean {
	const content = text.trim();
	if (!content || Object.keys(patterns).some(name => expressionsFor(name as keyof typeof patterns, overrides).some(expression => expression.test(content)))) return false;
	return expressionsFor("trivial", overrides).some(expression => expression.test(content));
}

export function detectSignals(messages: Array<{ text: string }>, overrides: SignalPatternOverrides = {}): string[] {
	const recentUsers = messages.map(message => userText(message.text)).filter((text): text is string => text !== undefined).slice(-6);
	return Object.keys(patterns).filter(name => recentUsers.some(text => expressionsFor(name as keyof typeof patterns, overrides).some(expression => expression.test(text))));
}
