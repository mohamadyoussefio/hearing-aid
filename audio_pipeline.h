#ifndef AUDIO_PIPELINE_H
#define AUDIO_PIPELINE_H

// ============================================================================
// audio_pipeline.h  —  Audio Shield (SGTL5000 / I2S) version
//
// Replaces the old PWM/IntervalTimer approach with the Teensy Audio Library.
//
// Audio graph
// -----------
//
//   [AudioInputI2S]  ──(L ch)──► [AudioMixer4]  ──► [AudioEQStream] ──► [AudioOutputI2S] (L+R)
//   [AudioSynthWaveformSine] ───────────────────►
//
//   Mixer channel 0 = microphone / line-in (via SGTL5000 ADC → I2S)
//   Mixer channel 1 = internal sine-wave tone generator (calibration / debug)
//
//   AudioEQStream is a custom AudioStream subclass that applies the
//   NUM_BANDS PeakEQ biquad chain to every 128-sample block the Audio
//   Library delivers.
//
// Mode switching (setDebugMode)
// ------------------------------
//   NORMAL      — mixer: mic=1, tone=0 | EQ active
//   PASSTHROUGH — mixer: mic=1, tone=0 | EQ bypassed (unity gain)
//   TONE        — mixer: mic=0, tone=1 | EQ bypassed
//   ADC_PRINT   — mixer: mic=1, tone=0 | output muted; raw samples buffered
//                 for loop() to print via flushAdcPrint()
//
// Threading model
// ---------------
//   AudioEQStream::update() is called by the Audio Library DMA interrupt
//   (~344 times/second, processing 128 samples each call).
//   All other public methods are called from loop() only.
//   Shared state is protected with __disable_irq() / __enable_irq() or
//   the Arduino noInterrupts() / interrupts() pair.
// ============================================================================

#include <Arduino.h>
#include <Audio.h>
#include <stdint.h>
#include "config.h"
#include "peak_eq.h"
#include "profile.h"

// ----------------------------------------------------------------------------
// DebugMode  (same enum as before — callers are unchanged)
// ----------------------------------------------------------------------------
enum class DebugMode : uint8_t {
    NORMAL      = 0,
    PASSTHROUGH = 1,
    TONE        = 2,
    ADC_PRINT   = 3
};

// ============================================================================
// AudioEQStream
//
// A single-input, single-output AudioStream that runs the NUM_BANDS PeakEQ
// filter chain on every block.  The AudioPipeline class owns one instance and
// controls it via the public setters below.
// ============================================================================
class AudioEQStream : public AudioStream {
public:
    AudioEQStream() : AudioStream(1, _inputQueue) {}

    // -----------------------------------------------------------------------
    // Profile / gain control  (safe to call from loop())
    // -----------------------------------------------------------------------

    // Replace the entire filter bank atomically.
    void loadProfile(const BandProfile *profile);

    // Update one band's gain without touching the others.
    void setGain(int band, float gainDB);

    // Copy the current live profile out.
    void getProfile(BandProfile *profile) const;

    // -----------------------------------------------------------------------
    // Mode flags  (written by loop(), read by update() interrupt)
    // All are declared volatile so the compiler never caches them.
    // -----------------------------------------------------------------------
    void setBypassed(bool b) { _bypassed = b; }   // true → unity-gain passthrough
    void setSilent(bool s)   { _silent   = s; }   // true → write zeros to output
    void setAdcPrint(bool a) { _adcPrint = a; }   // true → buffer input for Serial

    // -----------------------------------------------------------------------
    // Diagnostics  (snapshot-and-reset, safe to call from loop())
    // -----------------------------------------------------------------------
    float    snapshotPeakInput();
    float    snapshotPeakOutput();
    uint32_t snapshotLimiterHits();

    // -----------------------------------------------------------------------
    // ADC_PRINT support
    // The interrupt stores the most recent raw int16 sample here.
    // loop() polls isSampleUpdated() and calls clearSampleUpdate() after use.
    // -----------------------------------------------------------------------
    int16_t getLastSample()     const { return _lastSample;    }
    bool    isSampleUpdated()   const { return _sampleUpdated; }
    void    clearSampleUpdate()       { _sampleUpdated = false; }

    // -----------------------------------------------------------------------
    // Called by the Audio Library DMA interrupt ~344 times per second.
    // Processes one 128-sample block.  Do NOT call from loop().
    // -----------------------------------------------------------------------
    virtual void update() override;

private:
    audio_block_t *_inputQueue[1];   // required by AudioStream base class

    // Filter bank — swapped under noInterrupts() in loadProfile() / setGain()
    PeakEQ      _eqBands[NUM_BANDS];
    BandProfile _profile[NUM_BANDS];

    // Mode flags — volatile: written by loop(), read by update() ISR
    volatile bool _bypassed = false;
    volatile bool _silent   = false;
    volatile bool _adcPrint = false;

    // Diagnostic accumulators — written by update() ISR, read by loop()
    volatile float    _peakInput   = 0.0f;
    volatile float    _peakOutput  = 0.0f;
    volatile uint32_t _limiterHits = 0;

    // ADC_PRINT one-sample buffer
    volatile int16_t  _lastSample    = 0;
    volatile bool     _sampleUpdated = false;

    // Run x through all NUM_BANDS EQ filters in series.
    float _runEQ(float x);
};

// ============================================================================
// AudioPipeline
//
// Owns all Audio Library objects and connections, the AudioEQStream, and
// exposes the same public interface the rest of the sketch already uses.
// ============================================================================
class AudioPipeline {
public:

    // -----------------------------------------------------------------------
    // Audio Library objects
    // These MUST be public so HearingAid.ino can forward-declare them for the
    // Audio Library's connection wiring that happens at static-init time via
    // AudioConnection.  See HearingAid.ino for the wiring declarations.
    // -----------------------------------------------------------------------
    AudioInputI2S            i2sIn;
    AudioOutputI2S           i2sOut;
    AudioSynthWaveformSine   toneGen;
    AudioMixer4              inputMixer;
    AudioEQStream            eqStream;
    AudioControlSGTL5000     sgtl5000;

    // -----------------------------------------------------------------------
    // Core
    // -----------------------------------------------------------------------

    // Initialise the SGTL5000 codec, allocate Audio Library memory, load the
    // default profile, and set the initial debug mode to NORMAL.
    // Call once from setup() AFTER AudioMemory() and AudioConnection wiring.
    void init();

    // -----------------------------------------------------------------------
    // EQ control  (safe to call from loop())
    // -----------------------------------------------------------------------

    // Overwrite the gain of one band (freq and Q are preserved).
    //  band   — 0 .. NUM_BANDS-1
    //  gainDB — new gain in dB
    void setGain(int band, float gainDB);

    // Replace the entire filter bank with a new profile.
    void loadProfile(const BandProfile *profile);

    // Copy the current live profile into the caller-supplied array.
    void getProfile(BandProfile *profile) const;

    // Print the current profile to Serial as a formatted table.
    void printCurrentProfile() const;

    // -----------------------------------------------------------------------
    // Debug mode  (safe to call from loop())
    // -----------------------------------------------------------------------
    void      setDebugMode(DebugMode mode);
    DebugMode getDebugMode() const { return _debugMode; }

    // -----------------------------------------------------------------------
    // Tone generator control  (safe to call from loop())
    //
    // Sets the frequency and amplitude of the internal sine generator.
    // Call before switching to TONE mode (or during calibration).
    //  freqHz    — tone frequency in Hz
    //  amplitude — peak amplitude, normalised 0.0–1.0
    // -----------------------------------------------------------------------
    void setToneParams(float freqHz, float amplitude);

    // -----------------------------------------------------------------------
    // Diagnostics  (safe to call from loop())
    // -----------------------------------------------------------------------

    // Snapshot and reset all counters, then print a full diagnostic report
    // to Serial, including CPU/memory usage from the Audio Library.
    //  windowMs — elapsed milliseconds since the last call (for rate display)
    void printDiagnostics(uint32_t windowMs);

    // In ADC_PRINT mode, forward the latest buffered sample to Serial.
    // Rate-limited to ~10 prints/second.  No-op in other modes.
    void flushAdcPrint();

private:

    DebugMode _debugMode  = DebugMode::NORMAL;
    float     _toneFreq   = 1000.0f;
    float     _toneAmp    = 0.5f;

    // -----------------------------------------------------------------------
    // Internal helpers
    // -----------------------------------------------------------------------

    // Apply the correct mixer gains and EQ stream flags for the given mode.
    void _applyModeToHardware(DebugMode mode);
};

#endif // AUDIO_PIPELINE_H
