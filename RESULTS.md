# Results

## Qwen3.5-0.8B

16.5% - 1024 thinking, 2048 tokens, 3 passes, Qwen3.5-0.8B-MLX-4bit, 42m35s
20.7% - no thinking, 1024 tokens, 3 passes, Qwen3.5-0.8B-MLX-4bit, 7m50s
24.4% - no thinking, 1024 tokens, 3 passes, Qwen3.5-0.8B-MLX-bf16, 23m6s
27.4% - 1024 thinking, 2048 tokens, 3 passes, Qwen3.5-0.8B-MLX-bf16, 1h35m

Conclusions:
- 4bit no thinking is very fast and smart enough
- thinking makes 4bit worse, but improves 16bit
- 16bit thinking is the best, but slowest

## gemma-4-12B

97% - 8192 thinking, 16384 tokens, 1 pass, gemma-4-12B-it-8bit, 23h33m
96.3% - 8192 thinking, 16384 tokens, 1 pass, gemma-4-12B-it-8bit, 23h (partly using speculative decoding, hence the speedup iirc)

## Qwen3.6-27B

98.8% - 8192 thinking, 16384 tokens, 1 pass, Qwen3.6-27B-MLX-6bit, 24h8m
