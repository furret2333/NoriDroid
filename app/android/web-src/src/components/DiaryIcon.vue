<template>
	<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.65" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path :d="paths[name] || paths.book" /></svg>
</template>
<script setup lang="ts">
defineProps<{name: string}>()
const paths: Record<string, string> = {
	book: "M5 3h14v18H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2Zm0 0v14m-2 2a2 2 0 0 1 2-2h14M9 7h6M9 11h4",
	star: "m12 3 2.8 5.7 6.3.9-4.6 4.5 1.1 6.3-5.6-3-5.6 3 1.1-6.3L3 9.6l6.2-.9L12 3Z",
	calendar: "M8 3v4m8-4v4M4 10h16M5 5h14a1 1 0 0 1 1 1v14H4V6a1 1 0 0 1 1-1Zm3 9h2m4 0h2m-8 3h2",
	search: "M20 20l-5-5m2-6a7 7 0 1 1-14 0 7 7 0 0 1 14 0Z",
	pen: "m14 5 5 5M4 20l5-1L21 7l-5-5L4 14v6Z",
	left: "m14 6-6 6 6 6",
	right: "m10 6 6 6-6 6",
	down: "m6 9 6 6 6-6",
	more: "M5 12h.01M12 12h.01M19 12h.01",
	copy: "M8 8h12v13H8V8Zm8-4V2H3v14h2",
	export: "M12 3v12m-4-4 4 4 4-4M4 16v5h16v-5",
	share: "M8 12H4v9h16v-9h-4m-4 3V2m-5 5 5-5 5 5",
	close: "m6 6 12 12M6 18 18 6",
	spark: "m12 3 2.3 6.7L21 12l-6.7 2.3L12 21l-2.3-6.7L3 12l6.7-2.3L12 3Z",
	list: "M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01",
	check: "m5 12 4 4L19 6",
}
</script>
<style scoped>svg { width: 18px; height: 18px; flex: 0 0 auto; vertical-align: middle; }</style>
