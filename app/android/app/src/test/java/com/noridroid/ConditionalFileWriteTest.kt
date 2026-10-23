package com.noridroid

import java.nio.file.Files
import org.junit.Assert.*
import org.junit.Test

class ConditionalFileWriteTest {
    @Test fun diaryPrimaryBackupAndSourceCanBeCreatedAndReplacedOnDisk() {
        val dir = Files.createTempDirectory("nori-file-contract").toFile()
        try {
            for (name in listOf("memory.json", "nori-diary.json", "nori-diary.json.bak", "nori-diary-src.json")) {
                val file = java.io.File(dir, name)
                fun save(expected: String, content: String) = ConditionalFileWrite.run(name, expected, content,
                    read = { if (file.exists()) "ok" to file.readText() else "missing" to "" },
                    write = { file.writeText(it); "ok" })
                assertEquals("ok", save("", "first"))
                assertEquals("ok", save("first", "second"))
                assertEquals("conflict", save("first", "stale"))
                assertEquals("second", file.readText())
            }
        } finally { dir.deleteRecursively() }
    }

    @Test fun rejectsUnsupportedNamesBeforeAnyReadOrWrite() {
        for (name in listOf("settings.json", "../nori-diary.json", "nori-diary.json.tmp", "")) {
            assertEquals("err:unsupported", ConditionalFileWrite.run(name, "", "new",
                read = { fail("Unsupported file was read"); "ok" to "" },
                write = { fail("Unsupported file was written"); "ok" }))
        }
    }

    @Test fun unreadableFileIsNeverTreatedAsMissing() {
        for (status in listOf("error", "invalid")) {
            assertEquals("err:read", ConditionalFileWrite.run("nori-diary.json", "", "new",
                read = { status to "" }, write = { fail("Unreadable file was overwritten"); "ok" }))
        }
    }

    @Test fun preservesActualWriteFailure() {
        assertEquals("err:perm", ConditionalFileWrite.run("nori-diary.json", "old", "new",
            read = { "ok" to "old" }, write = { "err:perm" }))
    }
}
