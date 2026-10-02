import {defineConfig} from "vite"
import vue from "@vitejs/plugin-vue"
import path from "node:path"

const OUT_DIR = path.resolve(__dirname, "../app/src/main/assets/web")

export default defineConfig({
	plugins: [vue()],
	base: "./",
	resolve: {
		alias: {
			"@": path.resolve(__dirname, "src"),
		},
	},
	server: {
		host: "0.0.0.0",
		port: 5174,
	},
	build: {
		outDir: OUT_DIR,
		emptyOutDir: true,
		assetsInlineLimit: 0,
		chunkSizeWarningLimit: 10000,
		rollupOptions: {
			input: {
				// 主界面 + 悬浮窗 + 聊天气泡 三个入口
				main: path.resolve(__dirname, "index.html"),
				float: path.resolve(__dirname, "float.html"),
				bubble: path.resolve(__dirname, "bubble.html"),
			},
			output: {
				manualChunks: {
					live2d: ["live2d-easy-control"],
				},
			},
		},
	},
})
