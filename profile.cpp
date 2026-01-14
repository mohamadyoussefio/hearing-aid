#include "profile.h"
#include <Arduino.h>

const BandProfile DEFAULT_PROFILE[NUM_BANDS] = {
    {  250.0f, 1.2f,  6.0f },   // Band 0 — 250 Hz,  +6 dB
    {  500.0f, 1.3f,  4.0f },   // Band 1 — 500 Hz,  +4 dB
    { 1000.0f, 1.4f,  0.0f },   // Band 2 — 1 kHz,    0 dB (reference)
    { 2000.0f, 1.5f, -2.0f },   // Band 3 — 2 kHz,   -2 dB
    { 4000.0f, 1.6f,  7.0f },   // Band 4 — 4 kHz,   +7 dB
    { 8000.0f, 1.8f, 10.0f },   // Band 5 — 8 kHz,  +10 dB
};
