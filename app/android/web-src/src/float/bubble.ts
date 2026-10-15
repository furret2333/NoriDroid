import {createApp} from "vue"
import BubbleApp from "./BubbleApp.vue"
// 气泡聊天页同样吃「界面字体」设置
import "../assets/style/ui-fonts.less"
import {applyUiFont} from "../services/ui-font"
import {loadSettings} from "../services/chat"

applyUiFont(loadSettings().uiFont)
createApp(BubbleApp).mount("#bubble-app")