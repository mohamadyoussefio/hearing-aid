#ifndef CONFIG_H
#define CONFIG_H

// ============================================================================
// HearingAid — config.h
// Single source of truth for compile-time constants.
// ============================================================================

// Audio sample rate
#define SAMPLE_RATE         44100.0f

// EQ band count
#define NUM_BANDS           6

// Pin assignments
#define BUTTON_PIN          0

// Teensy Audio Shield — SGTL5000 codec settings
#define SGTL5000_VOLUME     0.7f
#define SGTL5000_MIC_GAIN   36
#define AUDIO_INPUT         AUDIO_INPUT_MIC

// Audio Library memory
#define AUDIO_MEMORY_BLOCKS 12

// Output limiter ceiling (normalised, 0.0–1.0)
#define MAX_OUTPUT          0.95f

// Diagnostics interval
#define DIAG_INTERVAL_MS    2000

#endif // CONFIG_H
