'use strict';

var path = require('path');

module.exports = {
  context: __dirname,
  entry: {
    duckhunt: './main.js',
  },
  // PetrifEye: built straight into games/duck-hunt/, next to the sprites and
  // audio, and committed — so running the piece never needs Node.
  mode: 'production',
  output: {
    path: path.join(__dirname, '..'),
    filename: '[name].js',
    chunkFilename: 'chunks/[name].js',
  },
  devtool: false,
  cache: {
    type: 'filesystem',
  },
  module: {
    rules: [
      {
        test: /\.js$/,
        exclude: /node_modules/,
        loader: 'babel-loader',
        options: {
          presets: ['@babel/preset-env'],
          cacheDirectory: true,
        },
      },
      {
        test: /\.(png|mp3|ogg)$/,
        type: 'asset/resource',
      },
    ]
  },
  resolve: {
    modules: ['node_modules'],
    extensions: ['.js', '.min.js'],
  },
  devServer: {
    static: path.join(__dirname, 'dist'),
    compress: true,
    port: 8080,
  },
};
