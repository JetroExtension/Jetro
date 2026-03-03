import React from "react";
import { Sparkline } from "./Sparkline";

interface ChartAreaProps {
  data: number[];
  color?: string;
  width?: number;
  height?: number;
}

export function ChartArea({
  data,
  color = "#DEBFCA",
  width = 280,
  height = 64,
}: ChartAreaProps) {
  return <Sparkline data={data} color={color} width={width} height={height} fill />;
}
