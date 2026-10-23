/** Request-only time hints sometimes get echoed by the model. Share the output policy. */
export const stripInternalPromptMetadata = (content: string): string => content
	.replace(/^[^\S\r\n]*(?:【(?:消息发送时间|消息发送时间未记录|当前时间)】|】)[^\S\r\n]*[^\r\n]*(?:\r?\n|$)/gim, (line) => {
		return /(?:消息发送时间|当前时间|\d{4}[-/]\d{1,2}[-/]\d{1,2}\s*\d{1,2}:\d{2})/.test(line) ? "" : line
	})
	.replace(/^\s*(?:当前时间\s*[:：]\s*)?\d{4}[-/]\d{1,2}[-/]\d{1,2}\s*\d{1,2}:\d{2}(?::\d{2})?\s*(?:[（(]\s*UTC\s*[+-]\s*\d{2}:?\d{2}\s*[）)])?\s*$/gim, "")
	.replace(/^\s*(?:[【\[（(]\s*)?UTC\s*[+-]\s*\d{2}:?\d{2}\s*(?:[】\]）)])?\s*$/gim, "")
	.replace(/^\s*(?:\(|\)|\[|\]|（|）|【|】)\s*$/gim, "")

const prefixes = ["【消息发送时间】", "【消息发送时间未记录】", "【当前时间】", "当前时间：", "当前时间:", "UTC"]
const mayBeMetadata = (line: string): boolean => {
	const text = line.trimStart()
	if (!text || prefixes.some(prefix => prefix.startsWith(text.toUpperCase()) || text.toUpperCase().startsWith(prefix))) return true
	// Hold date/time candidates until the line ends; ordinary prose still streams immediately.
	if (/^\d{1,4}$|^\d{4}[-/]|^】/.test(text)) return true
	return /^[【\[（(]\s*(?:U(?:T(?:C.*)?)?)?\s*$/i.test(text) || /^[）)\]]\s*$/.test(text)
}

/** Never release partial time labels to the UI or TTS, even across arbitrary network chunks. */
export const createReplyMetadataFilter = () => {
	let pending = ""
	let passthrough = false
	const push = (delta: string): string => {
		let output = ""
		for (const part of delta.split(/(?<=\n)/)) {
			if (!part) continue
			if (passthrough) output += part
			else {
				pending += part
				if (part.endsWith("\n") || !mayBeMetadata(pending)) {
					output += stripInternalPromptMetadata(pending)
					pending = ""
					passthrough = !part.endsWith("\n")
				}
			}
			if (part.endsWith("\n")) passthrough = false
		}
		return output
	}
	return {
		push,
		finish: (): string => {
			const output = stripInternalPromptMetadata(pending)
			pending = ""
			passthrough = false
			return output
		},
	}
}
