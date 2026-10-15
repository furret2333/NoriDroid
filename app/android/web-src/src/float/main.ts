import {createApp} from "vue"
import FloatApp from "./FloatApp.vue"
// 悬浮窗也吃「界面字体」设置：@font-face 与字体栈在这份文件里（悬浮窗不走 global.less）
import "../assets/style/ui-fonts.less"
import {applyUiFont} from "../services/ui-font"
import {loadSettings} from "../services/chat"

applyUiFont(loadSettings().uiFont)
createApp(FloatApp).mount("#float-app")
