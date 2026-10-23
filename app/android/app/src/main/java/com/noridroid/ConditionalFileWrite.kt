package com.noridroid

/** Caller must hold the shared file lock across both callbacks. */
internal object ConditionalFileWrite {
    val supportedNames = setOf("memory.json", "nori-diary.json", "nori-diary.json.bak", "nori-diary-src.json")

    fun run(name: String, expected: String, content: String,
            read: () -> Pair<String, String>, write: (String) -> String): String {
        if (name !in supportedNames) return "err:unsupported"
        val (status, current) = read()
        if (status != "ok" && status != "missing") return "err:read"
        if (current != expected) return "conflict"
        return write(content)
    }
}
