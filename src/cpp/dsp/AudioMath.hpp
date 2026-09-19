#pragma once

/**
 * ============================================================================
 * AudioMath.hpp - Базовые математические константы, функции и SIMD-детекция
 * ============================================================================
 * Низкоуровневые вспомогательные функции для аудиоядра DAW.
 * Стандарт: C++17. Не содержит динамических аллокаций памяти.
 * ============================================================================
 */

#include <cmath>
#include <cstdint>
#include <cstddef>
#include <algorithm>

// Аппаратная векторизация WebAssembly SIMD128 (-msimd128)
#if defined(__wasm_simd128__) || defined(__wasm_simd__)
#include <wasm_simd128.h>
#define USE_WASM_SIMD 1
#else
#define USE_WASM_SIMD 0
#endif

namespace DAWCore {

// Основные математические и аудиоконстанты
constexpr float PI_F = 3.14159265358979323846f;
constexpr float TWO_PI_F = 6.28318530717958647692f;
constexpr float MIN_DB = -120.0f;
constexpr float EPSILON = 1e-6f;
constexpr size_t MAX_TRACKS = 32;
constexpr size_t MAX_CLIPS_PER_TRACK = 64;
constexpr size_t MAX_BUFFER_SIZE = 8192; // Максимальный блок сэмплов (стерео = 2 * 8192)
constexpr size_t SIDECHAIN_RING_SIZE = 4096;
constexpr float TARGET_SAMPLE_RATE = 48000.0f;

/**
 * Перевод децибел в линейный коэффициент амплитуды
 */
inline float dbToGain(float db) noexcept {
    if (db <= MIN_DB) return 0.0f;
    return std::pow(10.0f, db * 0.05f);
}

/**
 * Перевод линейного коэффициента амплитуды в децибелы
 */
inline float gainToDb(float gain) noexcept {
    if (gain <= EPSILON) return MIN_DB;
    return 20.0f * std::log10(gain);
}

/**
 * Ограничение значения в заданном интервале [minVal, maxVal]
 */
inline float clampFloat(float val, float minVal, float maxVal) noexcept {
    return std::max(minVal, std::min(maxVal, val));
}

/**
 * Закон панорамирования постоянной мощности (Constant Power Panning)
 * Принимает pan в диапазоне [-1.0 (L) .. +1.0 (R)].
 * Возвращает коэффициенты panL и panR, сохраняющие суммарную акустическую энергию.
 */
inline void calculateConstantPowerPan(float pan, float& panL, float& panR) noexcept {
    float angle = (clampFloat(pan, -1.0f, 1.0f) + 1.0f) * 0.25f * PI_F;
    panL = std::cos(angle);
    panR = std::sin(angle);
}

} // namespace DAWCore
