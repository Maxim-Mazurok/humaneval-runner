# Results

Setup: 32GB MBP M5

## Qwen3.5-0.8B

- 15.2% - 1024 thinking, 2048 tokens, 3 passes, Qwen3.5-0.8B-MLX-4bit, 42m35s (16.5% if extracting code from thinking)
- 20.7% - no thinking, 1024 tokens, 3 passes, Qwen3.5-0.8B-MLX-4bit, 7m50s
- 24.4% - no thinking, 1024 tokens, 3 passes, Qwen3.5-0.8B-MLX-bf16, 23m6s
- 24.8% - 1024 thinking, 2048 tokens, 3 passes, Qwen3.5-0.8B-MLX-bf16, 1h35m (27.4% if extracting code from thinking)

Conclusions:
- 4bit no thinking is very fast and smart enough
- thinking makes 4bit worse, but improves 16bit
- 16bit thinking is the best, but slowest

## gemma-4-12B

- 97% - 8192 thinking, 16384 tokens, 1 pass, gemma-4-12B-it-8bit, 23h33m
- 96.3% - 8192 thinking, 16384 tokens, 1 pass, gemma-4-12B-it-8bit, 23h (partly using speculative decoding, hence the speedup iirc)

## Qwen3.6-27B

- [WIP 74/164 42.7-97.6%] 94.6% - 8192 thinking, 16384 tokens, 1 pass, Qwen3.5-27B-Claude-4.6-Opus-Distilled-MLX-4bit, 2h17m (failed: 32 (infinite loop), 41 (comment parsed as code), 65, 68)
- 98.8% - 8192 thinking, 16384 tokens, 3 passes, Qwen3.6-27B-MXFP4, 31h28m (failed, same in all passes: 134 (didn't handle edge case correctly, pretty clearly wrong assumption), 145) (#94 failed if extracting code from thinking)
- 98.8% - 8192 thinking, 16384 tokens, 1 pass, Qwen3.6-27B-MLX-6bit, 24h8m (failed: 32 (luck-based solution), 145 (tricky requirement misinterpretation); 2nd incomplete pass: 145)

Conclusions:
- Qwen3.6-27B is a very strong model
- MXFP4 runs 2.5x faster than 6bit and fits much more comfortably on the 32GB MBP M5, same eval accuracy
- Opus-Distilled quite a bit lower accuracy than base, might be more clever on math since that is what it was distilled on for the most part
