class ArgusResampler extends AudioWorkletProcessor {
  constructor() {
    super();
    this.sourceRate = sampleRate;
    this.targetRate = 16000;
    this.position = 0;
    this.buffer = [];
  }

  process(inputs) {
    const channel = inputs[0]?.[0];
    if (!channel?.length) return true;
    for (const sample of channel) this.buffer.push(sample);
    const ratio = this.sourceRate / this.targetRate;
    const output = [];
    while (this.position + 1 < this.buffer.length) {
      const left = Math.floor(this.position);
      const fraction = this.position - left;
      output.push(this.buffer[left] + (this.buffer[left + 1] - this.buffer[left]) * fraction);
      this.position += ratio;
    }
    const consumed = Math.floor(this.position);
    if (consumed > 0) {
      this.buffer.splice(0, consumed);
      this.position -= consumed;
    }
    if (output.length) this.port.postMessage(new Float32Array(output));
    return true;
  }
}

registerProcessor('argus-resampler', ArgusResampler);
