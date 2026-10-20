package com.noridroid

import org.junit.Assert.*
import org.junit.Test

class FloatingGeometryTest {
    private val screen = FloatingBounds(20, 80, 1060, 2200)

    private fun report() = FloatingModelGeometry(7, 3, 360, 472,
        intArrayOf(85, 10, 280, 390), intArrayOf(85, 10, 280, 390), 390, true)

    @Test fun rejectsOldModelGenerationAndOutOfOrderReports() {
        val r = report()
        assertTrue(acceptsFloatingGeometry(r, 7, 2, 360, 472))
        assertFalse(acceptsFloatingGeometry(r, 8, 2, 360, 472))
        assertFalse(acceptsFloatingGeometry(r, 7, 3, 360, 472))
        assertFalse(acceptsFloatingGeometry(r, 7, 9, 360, 472))
    }

    @Test fun rejectsPreResizeGeometryEvenWithNewSequence() {
        assertFalse(acceptsFloatingGeometry(report(), 7, 0, 720, 944))
        assertTrue(acceptsFloatingGeometry(report(), 7, 0, 362, 470))
    }

    @Test fun rejectsInvalidOrInconsistentVisibleGeometry() {
        val r = report()
        for (invalid in listOf(
            r.copy(crop = intArrayOf(100, 10, 200, 390)),
            r.copy(hit = intArrayOf(-1, 0, 100, 100)),
            r.copy(hit = intArrayOf(1, 1, 1, 2)),
            r.copy(crop = intArrayOf()), r.copy(feet = 999), r.copy(width = 0),
        )) assertFalse(acceptsFloatingGeometry(invalid, 7, 0, 360, 472))
    }

    @Test fun conservativeReactionWindowKeepsIndependentBodyAndFeet() {
        val r = report().copy(crop = intArrayOf(0, 0, 360, 472), precise = false)
        assertTrue(acceptsFloatingGeometry(r, 7, 0, 360, 472))
        assertEquals(FloatingFrame(0, 0, 360, 472), modelWindowCrop(360, 472, r.crop, 28))
        assertEquals(390, r.feet)
    }

    @Test fun actualModelCropRemovesInternalWhitespaceAndPreservesCanvasOrigin() {
        val crop = modelWindowCrop(360, 472, intArrayOf(86, 10, 272, 380), 40) // 20dp at density 2
        assertEquals(FloatingFrame(46, 0, 266, 420), crop)
        val fullX = -25
        val windowX = fullX + crop.x
        val webViewMargin = -crop.x
        assertEquals(fullX, windowX + webViewMargin)
    }

    @Test fun restoresOffScreenPositionInsideSystemBars() {
        assertEquals(FloatingFrame(20, 1900, 400, 300), fitFloatingWindow(-900, 3000, 400, 300, screen))
    }

    @Test fun smallScreenNeverProducesInvalidRange() {
        assertEquals(FloatingFrame(10, 20, 90, 60), fitFloatingWindow(-1, 999, 400, 300, FloatingBounds(10, 20, 100, 80)))
        assertEquals(FloatingFrame(0, 0, 1, 1), fitFloatingWindow(4, 5, 0, 0, FloatingBounds(0, 0, 0, 0)))
    }

    @Test fun onlySnapsNearAnEdge() {
        assertEquals(20, fitFloatingWindow(40, 200, 400, 300, screen, 28).x)
        assertEquals(660, fitFloatingWindow(640, 200, 400, 300, screen, 28).x)
        assertEquals(300, fitFloatingWindow(300, 200, 400, 300, screen, 28).x)
    }

    @Test fun modelCanvasWhitespaceCanLeaveScreenWithoutSnapping() {
        val rect = intArrayOf(300, 200, 500, 600)
        // 实体模型位于 (50,100)，完整画布原点在屏幕外也保持用户放置的位置。
        assertEquals(FloatingFrame(-250, -100, 1000, 1200),
            positionFloatingModel(-250, -100, 1000, 1200, rect, screen, 48))
        assertEquals(21, positionFloatingModel(21, 100, 200, 300, null, screen, 48).x)
    }

    @Test fun extremeDraggingKeepsRecoverableModelAreaAtEveryEdge() {
        val rect = intArrayOf(300, 200, 500, 600)
        for (x in listOf(-10000, 10000)) for (y in listOf(-10000, 10000)) {
            val f = positionFloatingModel(x, y, 1000, 1200, rect, screen, 48)
            val visibleW = minOf(f.x + rect[2], screen.right) - maxOf(f.x + rect[0], screen.left)
            val visibleH = minOf(f.y + rect[3], screen.bottom) - maxOf(f.y + rect[1], screen.top)
            assertEquals(48, visibleW)
            assertEquals(48, visibleH)
        }
    }

    @Test fun rotatedSmallDisplayDoesNotShrinkModelCanvas() {
        val rect = intArrayOf(300, 200, 500, 600)
        val tiny = FloatingBounds(0, 20, 100, 120)
        val f = positionFloatingModel(900, 1200, 1000, 1200, rect, tiny, 48)
        assertEquals(1000, f.width)
        assertEquals(1200, f.height)
        assertTrue(f.x + rect[0] < tiny.right && f.x + rect[2] > tiny.left)
        assertTrue(f.y + rect[1] < tiny.bottom && f.y + rect[3] > tiny.top)
    }

    @Test fun unknownModelStillAllowsPartialCanvasOffScreen() {
        for (rect in listOf(null, intArrayOf(), intArrayOf(1, 2, 1, 9))) {
            assertEquals(FloatingFrame(-200, -100, 500, 700),
                positionFloatingModel(-200, -100, 500, 700, rect, screen, 48))
        }
    }

    @Test fun recoveryAreaHandlesModelAndDisplaySmallerThanTouchTarget() {
        val b = FloatingBounds(0, 0, 10, 12)
        assertEquals(FloatingFrame(-8, -15, 100, 100),
            positionFloatingModel(-1000, -1000, 100, 100, intArrayOf(8, 15, 13, 21), b, 48))
        assertEquals(FloatingFrame(0, 0, 1, 1),
            positionFloatingModel(1000, -1000, 0, 0, null, FloatingBounds(0, 0, 0, 0), 48))
    }

    @Test fun shrinkingAtWidthLimitPreservesAspectRatio() {
        assertEquals(300 to 400, scaleFloatingSize(600, 800, 2f, 100, 140, 300, 900))
    }

    @Test fun heightMinimumConstrainsBothDimensions() {
        assertEquals(150 to 200, scaleFloatingSize(300, 400, 0.1f, 100, 200, 900, 1200))
    }

    @Test fun tinyScreenTakesPriorityOverMinimumWithoutDistortion() {
        assertEquals(60 to 80, scaleFloatingSize(300, 400, 1f, 100, 140, 60, 100))
    }

    @Test fun invalidPinchCannotCollapseWindow() {
        for (ratio in listOf(Float.NaN, Float.POSITIVE_INFINITY, 0f, -1f)) {
            assertEquals(300 to 400, scaleFloatingSize(300, 400, ratio, 100, 140, 600, 800))
        }
    }

    @Test fun cropKeepsPaddingAndCanvasCoordinates() {
        val crop = modelWindowCrop(500, 700, intArrayOf(100, 50, 400, 650), 28)
        assertEquals(FloatingFrame(72, 22, 356, 656), crop)
    }

    @Test fun cropClampsPartiallyOutsideModelToCanvas() {
        assertEquals(FloatingFrame(0, 0, 500, 700), modelWindowCrop(500, 700, intArrayOf(-30, -20, 530, 740), 28))
    }

    @Test fun unknownOrInvalidModelUsesWholeCanvas() {
        for (rect in listOf(null, intArrayOf(), intArrayOf(1, 2, 1, 9), intArrayOf(600, 0, 800, 700), intArrayOf(-100, 0, -20, 500))) {
            assertEquals(FloatingFrame(0, 0, 500, 700), modelWindowCrop(500, 700, rect, 28))
        }
    }

    @Test fun densityAffectsUiSizeButNotModelScreenCoordinates() {
        val layout = placeBubble(80, 200, 495, 649, 600, 770, 0, 80, 1080, 2400, 2.75f)
        assertEquals(822, layout.y) // 200 + 600 + 8dp
        assertEquals(49 + 22 + 154 + 825, layout.h)
        assertTrue(layout.x >= 0 && layout.x + layout.w <= 1080)
    }

    @Test fun bubbleFallsAboveModelWhenThereIsNoRoomBelow() {
        val layout = placeBubble(80, 1800, 495, 649, 600, 770, 0, 80, 1080, 2400, 2.75f)
        assertFalse(layout.belowModel)
        assertEquals(1778, layout.y + layout.h)
        assertTrue(layout.y >= 80)
    }

    @Test fun keyboardMovesWindowBeforeReducingHeight() {
        val original = FloatingFrame(40, 1600, 800, 500)
        val moved = fitFloatingWindow(original.x, original.y, original.width, original.height, FloatingBounds(0, 80, 1080, 1500))
        assertEquals(FloatingFrame(40, 1000, 800, 500), moved)
        val shortened = fitFloatingWindow(original.x, original.y, original.width, original.height, FloatingBounds(0, 80, 1080, 400))
        assertEquals(FloatingFrame(40, 80, 800, 320), shortened)
        assertEquals(original, fitFloatingWindow(original.x, original.y, original.width, original.height, screen))
    }
}
