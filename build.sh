#!/bin/bash
echo "Installing FFmpeg..."
apt-get update -y && apt-get install -y ffmpeg
echo "FFmpeg installed:"
which ffmpeg
ffmpeg -version | head -1
npm install
