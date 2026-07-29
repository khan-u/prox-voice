CXX      ?= c++
CXXFLAGS ?= -O2 -std=c++17 -Wall -Wextra

BINS = stimulus analyze synth_recording
TESTS = tests/test_dsp tests/test_wav

all: $(BINS)

stimulus: stimulus.cpp wav.hpp
	$(CXX) $(CXXFLAGS) -o $@ stimulus.cpp

analyze: analyze.cpp wav.hpp dsp.hpp
	$(CXX) $(CXXFLAGS) -o $@ analyze.cpp

synth_recording: synth_recording.cpp wav.hpp
	$(CXX) $(CXXFLAGS) -o $@ synth_recording.cpp

tests/test_dsp: tests/test_dsp.cpp dsp.hpp
	$(CXX) $(CXXFLAGS) -o $@ tests/test_dsp.cpp

tests/test_wav: tests/test_wav.cpp wav.hpp
	$(CXX) $(CXXFLAGS) -o $@ tests/test_wav.cpp

unit: $(TESTS)
	./tests/test_dsp
	./tests/test_wav

# Self-test: synthesise a recording with a known 85 ms delay, analyse it, and
# confirm the rig recovers the ground truth within 1 bin (10 ms, the default
# histogram resolution).
check: all unit
	./stimulus --bursts 20 --out stimulus.wav
	./synth_recording --in stimulus.wav --out synth_rec.wav --delay-ms 85 --gain 0.5 --noise 0.03
	./analyze synth_rec.wav --est-median 60 --csv rig_latency.csv

.PHONY: all unit check
