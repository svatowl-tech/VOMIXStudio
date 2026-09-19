#pragma once

/**
 * ============================================================================
 * WSOLATimeStretch.hpp - Алгоритм Waveform Similarity Overlap-Add (C++17, SIMD)
 * ============================================================================
 * Высокопроизводительное растяжение и сжатие звука во времени без изменения
 * высоты тона (Pitch-Preserving Time Scale Modification) для WebAssembly.
 *
 * Архитектурные особенности:
 * 1. Сохранение естественного тембра и формант (Pitch Preservation).
 * 2. Аппаратная векторизация взаимной корреляции через WASM SIMD128 (-msimd128).
 * 3. Поддержка моно и чередующихся (interleaved) стереобуферов.
 * 4. Фазосинхронный стереопроцессинг (Cross-Correlation по Mono-миксу,
 *    гарантирующий отсутствие фазовых искажений и гребенчатой фильтрации).
 * 5. Диапазон изменения скорости: от 0.5x (сжатие в 2 раза) до 2.0x (замедление).
 * ============================================================================
 */

#include "../dsp/AudioMath.hpp"
#include <cstdint>
#include <cstddef>
#include <vector>

namespace DAWCore {

/**
 * Класс WSOLATimeStretch - Высокоскоростное ядро тайм-стретчинга на базе WSOLA
 */
class WSOLATimeStretch {
public:
    static constexpr size_t DEFAULT_WINDOW_SIZE = 1024; // ~21.3 мс при 48 кГц
    static constexpr float MIN_STRETCH_RATIO = 0.5f;     // Ускорение 2x
    static constexpr float MAX_STRETCH_RATIO = 2.0f;     // Замедление 2x

    /**
     * Генерация сглаживающего окна Ханна (Hanning Window)
     * @param window Указатель на массив для записи весов окна
     * @param size Размер окна в сэмплах
     */
    static void generateHanningWindow(float* window, size_t size) noexcept;

    /**
     * Расчет ожидаемого количества кадров на выходе при заданном коэффициенте
     * @param inputFrames Длина входного сигнала в кадрах (frames)
     * @param ratio Коэффициент растяжения (0.5 .. 2.0)
     */
    static size_t calculateOutputFrames(size_t inputFrames, float ratio) noexcept;

    /**
     * Поиск оптимального сдвига взаимной корреляции с использованием SIMD128
     * @param input Входной моно-сигнал для поиска
     * @param templateBuf Эталонный буфер ожидаемого фазового продолжения
     * @param inFrames Общий размер входного буфера в кадрах
     * @param targetAnPos Расчетная позиция анализа
     * @param deltaMax Максимальный радиус поиска фазы (N / 2)
     * @param windowSize Размер окна анализа N
     * @return Оптимальный сдвиг delta (в сэмплах)
     */
    static int findBestDeltaSIMD(
        const float* input,
        const float* templateBuf,
        size_t inFrames,
        int targetAnPos,
        int deltaMax,
        size_t windowSize
    ) noexcept;

    /**
     * Растяжение/сжатие монофонического Float32 буфера
     * @param input Указатель на входные сэмплы
     * @param inFrames Длина входного буфера в сэмплах
     * @param output Указатель на выходной буфер достаточной емкости
     * @param maxOutFrames Максимальная емкость выходного буфера
     * @param ratio Коэффициент растяжения (0.5 .. 2.0)
     * @param windowSize Размер окна (по умолчанию 1024)
     * @return Фактическое количество записанных сэмплов
     */
    static size_t processMono(
        const float* input,
        size_t inFrames,
        float* output,
        size_t maxOutFrames,
        float ratio,
        size_t windowSize = DEFAULT_WINDOW_SIZE
    );

    /**
     * Растяжение/сжатие стереофонического interleaved буфера [L, R, L, R...]
     * @param input Указатель на стереосэмплы
     * @param inFrames Длина входного буфера в стереокадрах
     * @param output Указатель на выходной стереобуфер
     * @param maxOutFrames Максимальная емкость выходного буфера в кадрах
     * @param ratio Коэффициент растяжения (0.5 .. 2.0)
     * @param windowSize Размер окна (по умолчанию 1024)
     * @return Фактическое количество записанных стереокадров
     */
    static size_t processStereoInterleaved(
        const float* input,
        size_t inFrames,
        float* output,
        size_t maxOutFrames,
        float ratio,
        size_t windowSize = DEFAULT_WINDOW_SIZE
    );

    /**
     * Универсальный метод растяжения аудио с возвратом управляемого std::vector
     * @param input Входной буфер сэмплов
     * @param inFrames Количество кадров
     * @param ratio Коэффициент растяжения (0.5 .. 2.0)
     * @param isStereo true = стерео interleaved, false = моно
     * @return Результирующий буфер float сэмплов
     */
    static std::vector<float> processBuffer(
        const float* input,
        size_t inFrames,
        float ratio,
        bool isStereo = true
    );
};

} // namespace DAWCore
