

declare module "*.vue" {
	import type {DefineComponent} from "vue"
	const component: DefineComponent<{}, {}, any>
	export default component
}

declare module "*.webp" {
	const src: string
	export default src
}

declare module "*.png" {
	const src: string
	export default src
}

declare module "*.md?raw" {
	const src: string
	export default src
}

/** 许可全文以原文引入（2026-10-15: OFL 要求再分发字体时附带许可，所以打进包并在「开源许可」页展示） */
declare module "*.txt?raw" {
	const src: string
	export default src
}
