#include "audio_pipeline.h"
#include "config.h"
#include <Arduino.h>
#include <math.h>

// ============================================================================
// audio_pipeline.cpp  —  Audio Shield (SGTL5000 / I2S) version
//
// AudioEQStream::update() is invoked by the Teensy Audio Library's DMA
// interrupt roughly 344 times per second (44100 / 128 samples per block).
// It replaces the old IntervalTimer ISR and analogRead/analogWrite calls.
//
// AudioPipeline::init() configures the SGTL5000 codec and wires up the
// Audio Library graph.  All other public methods are unchanged from the
// caller's perspective.
// ============================================================================


// ============================================================================
// AudioEQStream — profile / gain control
// ============================================================================

void AudioEQStream::loadProfile(const BandProfile *profile) {
    // Build filters outside the critical section
    PeakEQ newBands[NUM_BANDS];
    for (int i = 0; i < NUM_BANDS; i++) {
        newBands[i] = createPeakEQ(
            profile[i].freqHz,
            profile[i].Q,
            profile[i].gainDB,
            SAMPLE_RATE
        );
    }

    // Atomically swap in
    noInterrupts();
    for (int i = 0; i < NUM_BANDS; i++) {
        _profile[i] = profile[i];
        _eqBands[i] = newBands[i];
    }
    interrupts();
}

void AudioEQStream::setGain(int band, float gainDB) {
    if (band < 0 || band >= NUM_BANDS) return;

    PeakEQ updated = createPeakEQ(
        _profile[band].freqHz,
        _profile[band].Q,
        gainDB,
        SAMPLE_RATE
    );

    noInterrupts();
    _profile[band].gainDB = gainDB;
    _eqBands[band]        = updated;
    interrupts();
}

void AudioEQStream::getProfile(BandProfile *profile) const {
    noInterrupts();
    for (int i = 0; i < NUM_BANDS; i++) {
        profile[i] = _profile[i];
    }
    interrupts();
}


// ============================================================================
// AudioEQStream — diagnostic snapshots
// ============================================================================

float AudioEQStream::snapshotPeakInput() {
    noInterrupts();
    float v = _peakInput;
    _peakInput = 0.0f;
    interrupts();
    return v;
}

float AudioEQStream::snapshotPeakOutput() {
    noInterrupts();
    float v = _peakOutput;
    _peakOutput = 0.0f;
    interrupts();
    return v;
}

uint32_t AudioEQStream::snapshotLimiterHits() {
    noInterrupts();
    uint32_t v = _limiterHits;
    _limiterHits = 0;
    interrupts();
    return v;
}


// ============================================================================
// AudioEQStream::_runEQ
// Pass x through all NUM_BANDS biquad filters in series.
// Called only from update() (interrupt context).
// ============================================================================
float AudioEQStream::_runEQ(float x) {
    for (int i = 0; i < NUM_BANDS; i++) {
        x = processPeakEQ(_eqBands[i], x);
    }
    return x;
}


// ============================================================================
// AudioEQStream::update
//
// Called by the Audio Library DMA interrupt, ~344 times/second.
// Processes one 128-sample block from the mixer output and forwards it to
// the I2S output stream.
//
// The Audio Library delivers samples as int16_t in the range -32768..+32767.
// We convert to float [-1, +1], apply processing, clamp, then convert back.
// ============================================================================
void AudioEQStream::update() {
    // Read local copies of volatile flags once so they are consistent
    // across the entire block even if loop() changes them mid-block.
    bool bypassed = _bypassed;
    bool silent   = _silent;
    bool adcPrint = _adcPrint;

    audio_block_t *inBlock = receiveReadOnly(0);

    if (silent) {
        // Output silence regardless of input
        if (inBlock) {
            // Still capture a sample for ADC_PRINT diagnostics
            if (adcPrint) {
                _lastSample    = inBlock->data[0];
                _sampleUpdated = true;
            }
            // Track peak input even when silent so diagnostics are meaningful
            float x = (float)inBlock->data[0] / 32768.0f;
            float absX = fabsf(x);
            if (absX > _peakInput) _peakInput = absX;

            release(inBlock);
        }
        // Transmit nothing — the Audio Library will insert silence downstream
        return;
    }

    if (!inBlock) {
        // No block available; transmit nothing (silence)
        return;
    }

    audio_block_t *outBlock = allocate();
    if (!outBlock) {
        release(inBlock);
        return;
    }

    for (int i = 0; i < AUDIO_BLOCK_SAMPLES; i++) {
        // Convert int16 → float
        float x = (float)inBlock->data[i] / 32768.0f;

        // Track peak input
        float absX = fabsf(x);
        if (absX > _peakInput) _peakInput = absX;

        // Process
        float y = bypassed ? x : _runEQ(x);

        // Hard limiter
        if (y > MAX_OUTPUT) {
            y = MAX_OUTPUT;
            _limiterHits++;
        } else if (y < -MAX_OUTPUT) {
            y = -MAX_OUTPUT;
            _limiterHits++;
        }

        // Track peak output
        float absY = fabsf(y);
        if (absY > _peakOutput) _peakOutput = absY;

        // Convert float → int16
        outBlock->data[i] = (int16_t)(y * 32767.0f);
    }

    // Buffer one sample for ADC_PRINT mode
    if (adcPrint) {
        _lastSample    = inBlock->data[0];
        _sampleUpdated = true;
    }

    release(inBlock);
    transmit(outBlock);
    release(outBlock);
}


// ============================================================================
// AudioPipeline::_applyModeToHardware
//
// Sets mixer channel gains and AudioEQStream flags to match the given mode.
// Called from setDebugMode() and init().
// ============================================================================
void AudioPipeline::_applyModeToHardware(DebugMode mode) {
    switch (mode) {

        case DebugMode::NORMAL:
            // Microphone → EQ → output
            inputMixer.gain(0, 1.0f);   // mic on
            inputMixer.gain(1, 0.0f);   // tone off
            inputMixer.gain(2, 0.0f);
            inputMixer.gain(3, 0.0f);
            eqStream.setBypassed(false);
            eqStream.setSilent(false);
            eqStream.setAdcPrint(false);
            break;

        case DebugMode::PASSTHROUGH:
            // Microphone → output, EQ bypassed
            inputMixer.gain(0, 1.0f);
            inputMixer.gain(1, 0.0f);
            inputMixer.gain(2, 0.0f);
            inputMixer.gain(3, 0.0f);
            eqStream.setBypassed(true);
            eqStream.setSilent(false);
            eqStream.setAdcPrint(false);
            break;

        case DebugMode::TONE:
            // Internal sine → output, EQ bypassed (mic is irrelevant)
            inputMixer.gain(0, 0.0f);   // mic off
            inputMixer.gain(1, 1.0f);   // tone on
            inputMixer.gain(2, 0.0f);
            inputMixer.gain(3, 0.0f);
            eqStream.setBypassed(true);
            eqStream.setSilent(false);
            eqStream.setAdcPrint(false);
            break;

        case DebugMode::ADC_PRINT:
            // Microphone sampled, output muted, raw values sent to Serial
            inputMixer.gain(0, 1.0f);
            inputMixer.gain(1, 0.0f);
            inputMixer.gain(2, 0.0f);
            inputMixer.gain(3, 0.0f);
            eqStream.setBypassed(true);
            eqStream.setSilent(true);
            eqStream.setAdcPrint(true);
            break;
    }
}


// ============================================================================
// AudioPipeline::init
//
// Call from setup() after AudioMemory() has been called and AudioConnection
// objects have been constructed (see HearingAid.ino).
// ============================================================================
void AudioPipeline::init() {
    // --- Initialise the SGTL5000 codec on the Audio Shield ---
    sgtl5000.enable();
    sgtl5000.volume(SGTL5000_VOLUME);
    sgtl5000.inputSelect(AUDIO_INPUT);      // AUDIO_INPUT_MIC or AUDIO_INPUT_LINEIN
    sgtl5000.micGain(SGTL5000_MIC_GAIN);    // pre-amp gain in dB

    // --- Load the default EQ profile ---
    BandProfile defaultProfile[NUM_BANDS];
    loadDefaultProfile(defaultProfile);
    eqStream.loadProfile(defaultProfile);

    // --- Set initial tone generator state ---
    toneGen.frequency(_toneFreq);
    toneGen.amplitude(0.0f);   // silent until a mode switch enables it

    // --- Apply the default mode ---
    _applyModeToHardware(_debugMode);
}


// ============================================================================
// AudioPipeline::setGain
// ============================================================================
void AudioPipeline::setGain(int band, float gainDB) {
    if (band < 0 || band >= NUM_BANDS) return;
    eqStream.setGain(band, gainDB);

    Serial.print(F("ACK  band="));
    Serial.print(band);
    Serial.print(F("  gain="));
    Serial.print(gainDB, 1);
    Serial.println(F(" dB"));
}


// ============================================================================
// AudioPipeline::loadProfile
// ============================================================================
void AudioPipeline::loadProfile(const BandProfile *profile) {
    eqStream.loadProfile(profile);
}


// ============================================================================
// AudioPipeline::getProfile
// ============================================================================
void AudioPipeline::getProfile(BandProfile *profile) const {
    eqStream.getProfile(profile);
}


// ============================================================================
// AudioPipeline::printCurrentProfile
// ============================================================================
void AudioPipeline::printCurrentProfile() const {
    BandProfile snapshot[NUM_BANDS];
    eqStream.getProfile(snapshot);
    printProfile(snapshot);
}


// ============================================================================
// AudioPipeline::setDebugMode
// ============================================================================
void AudioPipeline::setDebugMode(DebugMode mode) {
    bool modeChanged = (mode != _debugMode);

    _debugMode = mode;
    _applyModeToHardware(mode);

    // Update the tone generator amplitude: non-zero only in TONE mode
    toneGen.amplitude((mode == DebugMode::TONE) ? _toneAmp : 0.0f);

    // Only print the mode-change message when the mode actually changes.
    // Calibration calls setDebugMode(TONE) on every amplitude step; suppressing
    // the redundant prints keeps the Serial output readable during sweeps.
    if (!modeChanged) return;

    Serial.print(F("Mode -> "));
    switch (mode) {
        case DebugMode::NORMAL:
            Serial.println(F("NORMAL (mic -> EQ -> headphones)"));
            break;
        case DebugMode::PASSTHROUGH:
            Serial.println(F("PASSTHROUGH (mic -> headphones, EQ bypassed)"));
            break;
        case DebugMode::TONE:
            Serial.print(F("TONE (internal sine @ "));
            Serial.print(_toneFreq, 0);
            Serial.print(F(" Hz, amp="));
            Serial.print(_toneAmp, 2);
            Serial.println(F(") -> headphones"));
            break;
        case DebugMode::ADC_PRINT:
            Serial.println(F("ADC_PRINT (mic sampled, output muted, raw values to Serial)"));
            break;
    }
}


// ============================================================================
// AudioPipeline::setToneParams
// ============================================================================
void AudioPipeline::setToneParams(float freqHz, float amplitude) {
    _toneFreq = freqHz;
    _toneAmp  = amplitude;

    toneGen.frequency(freqHz);

    // Only drive the output if we are currently in TONE mode
    toneGen.amplitude((_debugMode == DebugMode::TONE) ? amplitude : 0.0f);
}


// ============================================================================
// AudioPipeline::flushAdcPrint
//
// Called from loop() at full speed; rate-limited internally to ~10 prints/s.
// Prints the latest int16 sample captured by AudioEQStream::update() in
// ADC_PRINT mode as a normalised float, matching the old format.
// ============================================================================
void AudioPipeline::flushAdcPrint() {
    if (_debugMode != DebugMode::ADC_PRINT) return;

    static uint32_t lastPrintMs = 0;
    uint32_t now = millis();
    if (now - lastPrintMs < 100) return;
    lastPrintMs = now;

    if (!eqStream.isSampleUpdated()) return;

    int16_t raw = eqStream.getLastSample();
    eqStream.clearSampleUpdate();

    // Normalise to [-1.0, +1.0] — same presentation as the old ADC version
    float norm    = (float)raw / 32768.0f;
    // Map to a 0–4095 "raw ADC" equivalent so the output format is familiar
    int   rawAdc  = (int)((norm + 1.0f) * 2047.5f);
    // Approximate voltage: 3.3 V full-scale on the codec input
    float voltage = (norm + 1.0f) * 0.5f * 3.3f;

    Serial.print(F("ADC  raw="));
    Serial.print(rawAdc);
    Serial.print(F("  voltage="));
    Serial.print(voltage, 3);
    Serial.print(F(" V  norm="));
    Serial.println(norm, 4);
}


// ============================================================================
// AudioPipeline::printDiagnostics
// ============================================================================
void AudioPipeline::printDiagnostics(uint32_t windowMs) {
    // Snapshot and reset EQ stream counters
    float    peakIn  = eqStream.snapshotPeakInput();
    float    peakOut = eqStream.snapshotPeakOutput();
    uint32_t limHits = eqStream.snapshotLimiterHits();

    // Audio Library CPU and memory stats
    float    cpuUsage    = AudioProcessorUsage();
    float    cpuUsageMax = AudioProcessorUsageMax();
    uint8_t  memUsage    = AudioMemoryUsage();
    uint8_t  memUsageMax = AudioMemoryUsageMax();
    AudioProcessorUsageMaxReset();
    AudioMemoryUsageMaxReset();

    DebugMode mode = _debugMode;

    // --- ASCII bar graphs (20 chars wide; each char = 5 % of full scale) ---
    char inBar[21], outBar[21];
    int  barLen;

    barLen = (int)(peakIn * 20.0f);
    if (barLen < 0) barLen = 0;
    if (barLen > 20) barLen = 20;
    for (int i = 0; i < 20; i++) inBar[i]  = (i < barLen) ? '#' : '-';
    inBar[20] = '\0';

    barLen = (int)(peakOut * 20.0f);
    if (barLen < 0) barLen = 0;
    if (barLen > 20) barLen = 20;
    for (int i = 0; i < 20; i++) outBar[i] = (i < barLen) ? '#' : '-';
    outBar[20] = '\0';

    // --- Print ---
    Serial.println(F("========== DIAGNOSTICS =========="));

    Serial.print(F("  Mode        : "));
    switch (mode) {
        case DebugMode::NORMAL:      Serial.println(F("NORMAL"));      break;
        case DebugMode::PASSTHROUGH: Serial.println(F("PASSTHROUGH")); break;
        case DebugMode::TONE:        Serial.println(F("TONE"));        break;
        case DebugMode::ADC_PRINT:   Serial.println(F("ADC_PRINT"));   break;
    }

    Serial.print(F("  CPU usage   : "));
    Serial.print(cpuUsage, 1);
    Serial.print(F(" %  (max "));
    Serial.print(cpuUsageMax, 1);
    Serial.println(F(" %)"));

    Serial.print(F("  Audio mem   : "));
    Serial.print(memUsage);
    Serial.print(F(" blocks used  (max "));
    Serial.print(memUsageMax);
    Serial.print(F(", allocated "));
    Serial.print(AUDIO_MEMORY_BLOCKS);
    Serial.println(F(")"));

    Serial.print(F("  Input peak  : "));
    Serial.print(peakIn, 4);
    Serial.print(F("  ["));
    Serial.print(inBar);
    Serial.println(F("]"));

    Serial.print(F("  Output peak : "));
    Serial.print(peakOut, 4);
    Serial.print(F("  ["));
    Serial.print(outBar);
    Serial.println(F("]"));

    Serial.print(F("  Limiter hits: "));
    Serial.println(limHits);

    // --- Status checks ---
    bool ok = true;

    if (cpuUsage < 0.1f && windowMs > 500) {
        Serial.println(F("  [FAIL] CPU usage near zero — Audio Library not running, check AudioMemory() and AudioConnection wiring"));
        ok = false;
    }

    if (memUsageMax >= AUDIO_MEMORY_BLOCKS) {
        Serial.println(F("  [WARN] Audio memory pool exhausted — increase AUDIO_MEMORY_BLOCKS in config.h"));
        ok = false;
    }

    if (mode == DebugMode::NORMAL || mode == DebugMode::PASSTHROUGH) {
        if (peakIn < 0.005f) {
            Serial.println(F("  [WARN] Input near zero — check mic wiring and AUDIO_INPUT in config.h (MIC vs LINEIN)"));
            ok = false;
        } else if (peakIn > 0.99f) {
            Serial.println(F("  [WARN] Input clipping — reduce SGTL5000_MIC_GAIN in config.h"));
            ok = false;
        }
        if (peakIn > 0.01f && peakOut < 0.001f) {
            Serial.println(F("  [FAIL] Signal at input but output silent — check AudioConnection wiring in HearingAid.ino"));
            ok = false;
        }
    }

    if (mode == DebugMode::TONE) {
        if (peakOut < 0.01f) {
            Serial.println(F("  [FAIL] Tone output silent — check AudioConnection from toneGen and SGTL5000 volume"));
            ok = false;
        } else {
            Serial.print(F("  [INFO] Tone active @ "));
            Serial.print(_toneFreq, 0);
            Serial.println(F(" Hz — you should hear it in the headphones"));
        }
    }

    uint32_t limitThresh = (uint32_t)(SAMPLE_RATE * (float)windowMs / 1000.0f * 0.1f);
    if (limHits > limitThresh) {
        Serial.println(F("  [WARN] Limiter active >10% of the time — reduce gain or mic level"));
        ok = false;
    }

    if (ok) {
        Serial.println(F("  [OK]  All checks passed."));
    }

    Serial.println(F("================================="));
}
